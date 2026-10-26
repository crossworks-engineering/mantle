/**
 * circuit_trace: one piping circuit across the uploaded DWG/DXF drawings,
 * from their bones tabs (Segments, Nodes, Inserts, Blocks, Texts, Circuits).
 * Read-only. The walk is ./circuit-trace/walk.ts (pure), the read
 * ./circuit-trace/read.ts (the caller's own scope, table by table).
 *
 * The output carries drawing text (labels, attribute values, layer names)
 * that whoever uploaded the drawing wrote, so the policy marks it
 * `outside.untrusted`: the tool loop fences every result as data before a
 * model reads it, as it does a web page's. The rights are the read's own.
 */
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';
import { dwgTables, readSheet, type CandidateTable } from './circuit-trace/read';
import { dwgReindexCommand as reindexCommand } from '@mantle/files/dwg';
import {
  appliedChecks,
  CHECK_KINDS,
  VERIFY_MAX,
  type AppliedCheck,
  type CheckKind,
} from './circuit-trace/check';
import { storeChecks, storeRefusal } from './circuit-trace/checks-store';
import { sealedPid } from './circuit-trace/check-seal';
import { verifyCircuit } from './circuit-trace/verify';
import { bumpWorkerUsage, currentActor, type AiWorker } from '@mantle/db';
import { resolveDefaultWorker } from '@mantle/api-keys';
import { mediaDwgCrop, readFileById } from '@mantle/files';
import { extractImages, multiImageProvider, type ProviderCredential } from '@mantle/voice';
import { CS } from './client-sourced-rule';
import { traceCircuit, type RegisterInput, type SheetInput } from './circuit-trace/walk';
import { CIRCUIT_DRAWING_STEPS, imageCheckReport, VERIFY_ONCE } from './circuit-trace/workflow';

/** The register's size, held both in the schema and here (a schema in
 *  warn mode lets more through): lines and sheets read, and the longest
 *  text kept per field. */
export const REGISTER_MAX = { lines: 2000, sheets: 200, text: 120 } as const;

/** A register field as text: control characters out, trimmed, capped. */
const field = (v: unknown) =>
  str(v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
    .slice(0, REGISTER_MAX.text)
    .trim();

/** The register input, read loosely: the agent fills it from a site tool.
 *  `cut` says what was past the caps. */
export function registerOf(raw: unknown): { register?: RegisterInput; cut: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { cut: [] };
  const r = raw as Record<string, unknown>;
  const cut: string[] = [];
  const rawLines = Array.isArray(r.lines) ? r.lines : [];
  if (rawLines.length > REGISTER_MAX.lines)
    cut.push(
      `the register gave ${rawLines.length} lines; the first ${REGISTER_MAX.lines} were compared`,
    );
  const lines = rawLines
    .slice(0, REGISTER_MAX.lines)
    .map((l) => {
      if (typeof l === 'string') return field(l) ? { number: field(l) } : null;
      if (!l || typeof l !== 'object') return null;
      const o = l as Record<string, unknown>;
      const number = field(o.number);
      if (!number) return null;
      return {
        number,
        ...(field(o.sheet) ? { sheet: field(o.sheet) } : {}),
        ...(typeof o.deadleg === 'boolean' ? { deadleg: o.deadleg } : {}),
      };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);
  const rawSheets = Array.isArray(r.sheets) ? r.sheets : [];
  if (rawSheets.length > REGISTER_MAX.sheets)
    cut.push(
      `the register gave ${rawSheets.length} sheets; the first ${REGISTER_MAX.sheets} were compared`,
    );
  const sheets = rawSheets.slice(0, REGISTER_MAX.sheets).map(field).filter(Boolean);
  return {
    register: {
      ...(field(r.source) ? { source: field(r.source) } : {}),
      ...(field(r.from) ? { from: field(r.from) } : {}),
      ...(field(r.to) ? { to: field(r.to) } : {}),
      lines,
      sheets,
      ...(typeof r.deadlegs === 'number' && Number.isFinite(r.deadlegs)
        ? { deadlegs: r.deadlegs }
        : {}),
    },
    cut,
  };
}

/**
 * The sheets of one circuit the caller reads, with what the read could not
 * do said in `limits`: one table that cannot be opened (its workbook file
 * missing, a store refusal) is skipped and named, never the end of the
 * whole trace. Shared by circuit_trace and circuit_verify.
 */
export async function readCircuitSheets(
  ownerId: string,
  circuit: string,
): Promise<{ sheets: SheetInput[]; tables: CandidateTable[]; limits: string[] }> {
  const { tables, more } = await dwgTables(ownerId);
  const sheets: SheetInput[] = [];
  const limits: string[] = [];
  const preBones: string[] = [];
  const unreadable: string[] = [];
  for (const t of tables) {
    const r = await readSheet(ownerId, t, circuit).catch(() => null);
    if (!r) unreadable.push(t.title);
    else if (r.kind === 'sheet') sheets.push(r.sheet);
    else if (r.kind === 'no-bones') preBones.push(r.title);
  }
  if (more) {
    limits.push(
      `only the ${tables.length} most recently changed drawing tables were looked at; older sheets of this circuit may be missing.`,
    );
  }
  for (const title of unreadable) {
    limits.push(
      `${title}: its table could not be opened, so it was skipped; if it carries this circuit, the trace is missing that sheet.`,
    );
  }
  for (const s of sheets) {
    if (s.source === 'stale')
      limits.push(
        `${s.title}: its drawing file was replaced after its table was built, so this sheet's geometry is the older revision; an owner can rebuild it with ${reindexCommand(s.sourceFileId)}, then trace again.`,
      );
    else if (s.source === 'unreadable')
      limits.push(
        `${s.title}: whether its table still matches its drawing file could not be checked (you cannot read the source file, or it is gone), so the sheet may hold an older revision of the drawing.`,
      );
  }
  for (const title of preBones) {
    limits.push(
      `${title}: has the circuit's layers but its table predates the geometry tabs; an owner can rebuild it with the dwg-reindex maintenance task.`,
    );
  }
  return { sheets, tables, limits };
}

/** The applied checks as circuit_trace reports them, with a count line. */
function checksSummary(applied: AppliedCheck[]) {
  const n = (v: string) => applied.filter((c) => c.answer === v).length;
  return {
    note: `${applied.length} guess${applied.length === 1 ? '' : 'es'} checked by image (circuit_verify): ${n('yes')} confirmed (CHECKED BY IMAGE, still not certain), ${n('no')} contradicted (still a guess), ${n('unsure')} unsure (still a guess). Each is the latest sealed answer in the drawing table's Checks tab: a table editor who deletes a newer row brings the older answer back.`,
    items: applied.map((c) => ({
      sheet: c.sheet,
      kind: c.kind,
      ...(c.node !== null ? { node: c.node } : {}),
      guess: c.guess,
      trust: c.trust,
      ...(c.alt ? { image_says: c.alt } : {}),
      reason: c.reason,
      model: c.model,
      checked_at: c.checkedAt,
    })),
  };
}

export async function circuitTraceHandler(
  input: Record<string, unknown>,
  ownerId: string,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  const circuit = str(input.circuit).trim();
  if (!circuit) {
    return {
      ok: false,
      error:
        "circuit is required: the circuit's name as the drawings write it, e.g. '10000-001-01' (the part after 'Circuit ' in the layer name).",
    };
  }
  const { register, cut } = registerOf(input.register);
  try {
    const read = await readCircuitSheets(ownerId, circuit);
    const { sheets } = read;
    // The image check's stored answers (circuit_verify): matched to this
    // trace's guesses before the drawing is made.
    const applied: AppliedCheck[] = [];
    const checkLimits: string[] = [];
    const result = traceCircuit(circuit, sheets, register, {
      checks: (walked, links) =>
        appliedChecks(walked, links, sheets, applied, checkLimits, register),
    });
    result.limits.push(...cut, ...read.limits, ...checkLimits);
    const { estimateMeasurer, render, validate, withImageCheckSummary, imageCheckSummary } =
      await import('@mantle/diagram-templates');
    // The marks sealed (a save keeps only these: @mantle/content
    // drawing-seal), then the image check counts from the drawing's own
    // marks, as every save counts them.
    const pid = withImageCheckSummary(sealedPid(result.pid, result.cutCheckKeys, result.limits));
    const imageCheck = imageCheckReport(imageCheckSummary(pid));
    const checked = validate('pid', pid);
    // The data check, then the layout of every page with the estimate
    // measurer: a page that passes the check but cannot be laid out is an
    // error here, named by its page, not a broken page on the saved canvas.
    const drawn = checked.ok ? render('pid', pid, estimateMeasurer) : null;
    const errors = !checked.ok
      ? checked.errors
      : drawn && !drawn.ok
        ? drawn.errors
        : (drawn?.failed ?? []).map(
            (f) =>
              `${f.path}: page '${f.page}' passes the data check but its layout failed (${f.error}); the canvas would show an error panel there. This is a template bug; report it with the circuit.`,
          );
    return {
      ok: true,
      output: {
        summary: result.summary,
        circuit: result.circuit,
        sheets: result.sheets,
        links: result.links,
        pid,
        pid_check: {
          ok: errors.length === 0,
          ...(errors.length ? { errors } : {}),
          warnings: checked.warnings,
        },
        ...(result.register ? { register: result.register } : {}),
        guesses: result.guesses,
        ...(applied.length ? { checks: checksSummary(applied) } : {}),
        ...(imageCheck ? { image_check: imageCheck } : {}),
        limits: result.limits,
        ...(result.sheets.every((x) => x.runs.length === 0)
          ? {
              hint: `No readable drawing has geometry on 'Circuit ${circuit}' layers. Check the name with table_sql on a DWG table's Circuits tab, or search_nodes for the drawing.`,
            }
          : {
              next:
                (imageCheck?.unchecked
                  ? `${imageCheck.unchecked} guess${imageCheck.unchecked === 1 ? ' is' : 'es are'} not checked by image yet: circuit_verify on circuit ${JSON.stringify(circuit)} checks them (spends the owner's vision key; dry_run lists the questions for free), then call circuit_trace again and save THAT pid. ${VERIFY_ONCE} `
                  : '') +
                ('pages' in pid
                  ? `Save it as ONE canvas: present_create with template "pid" and the pid object, unchanged, as data (a drawing set: page 1 the overview, then a page per sheet named after it, linked; pid_check must be ok first). diagram_render shows page 1; present_render with slide N shows page N; present_export writes every page stacked, links printed as page references. Never drop or relabel a GUESS, CHECKED BY IMAGE or FROM IMAGE mark.`
                  : `Save it as a canvas: present_create with template "pid" and the pid object, unchanged, as data (one drawing; pid_check must be ok first); present_export writes it for a page. Never drop or relabel a GUESS, CHECKED BY IMAGE or FROM IMAGE mark.`),
              workflow: CIRCUIT_DRAWING_STEPS,
            }),
      },
    };
  } catch (err) {
    return { ok: false, error: `circuit_trace failed: ${errorMessage(err)}` };
  }
}

/** The register input, shared by circuit_trace and circuit_verify. */
const REGISTER_SCHEMA = {
  type: 'object',
  description:
    'What an outside register says belongs to the circuit, from a site register tool when the brain has one; the trace reports every difference. Leave it out when there is none.',
  properties: {
    source: {
      type: 'string',
      maxLength: REGISTER_MAX.text,
      description: "Where it came from, e.g. 'site register tool'.",
    },
    from: {
      type: 'string',
      maxLength: REGISTER_MAX.text,
      description:
        "The circuit's upstream end as the register names it, an equipment tag, e.g. 'E-101'. Fixes the main line's start.",
    },
    to: {
      type: 'string',
      maxLength: REGISTER_MAX.text,
      description: "The circuit's downstream end, an equipment tag, e.g. 'V-201'.",
    },
    lines: {
      type: 'array',
      maxItems: REGISTER_MAX.lines,
      description: 'The line numbers on the circuit.',
      items: {
        type: 'object',
        properties: {
          number: {
            type: 'string',
            maxLength: REGISTER_MAX.text,
            description: "A line number, e.g. '2\"-P-0001-A1'.",
          },
          sheet: {
            type: 'string',
            maxLength: REGISTER_MAX.text,
            description: 'The drawing it is on, e.g. a sheet number.',
          },
          deadleg: { type: 'boolean', description: 'The register marks it a deadleg.' },
        },
        required: ['number'],
        additionalProperties: false,
      },
    },
    sheets: {
      type: 'array',
      maxItems: REGISTER_MAX.sheets,
      items: { type: 'string', maxLength: REGISTER_MAX.text },
      description: 'Drawings the register lists for the circuit.',
    },
    deadlegs: {
      type: 'integer',
      minimum: 0,
      description: 'How many deadlegs the register lists.',
    },
  },
  additionalProperties: false,
} as const;

const circuit_trace: BuiltinToolDef = {
  slug: 'circuit_trace',
  policy: {
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'tables',
    // Drawing text is the uploader's: fenced as data (the header says why).
    outside: { untrusted: true },
  },
  name: 'Trace a piping circuit',
  description:
    "Trace one piping circuit across every uploaded DWG/DXF drawing you can read, from the geometry on its `Circuit <name>` layers: per sheet the runs as ordered chains, tees, ends, deadlegs, valves, line numbers with their DWG handles and equipment at the ends; links between sheets (certain only when both ends' labels name each other's sheet and both ends carry the same line number; else `guessed`); guesses marked GUESS on the drawing; `pid`, the drawing (a linked set past one page); `image_check`, the guesses no image has checked; and, with `register`, every difference against it. Reads only. Then `circuit_verify`, trace again, and save that `pid` with `present_create`. For one drawing's raw tabs use `table_sql`.",
  inputSchema: {
    type: 'object',
    properties: {
      circuit: {
        type: 'string',
        description:
          "The circuit's name exactly as the layer writes it after 'Circuit ', e.g. '10000-001-01'.",
      },
      register: REGISTER_SCHEMA,
    },
    required: ['circuit'],
  },
  handler: (input, ctx) => circuitTraceHandler(input, ctx.ownerId),
};

/** A flag the agent may send as a boolean or as its word. */
export const verifyFlag = (v: unknown) =>
  v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');

/** The reply's token budget, and the part a reasoning model may think with
 *  (OpenRouter `reasoning.max_tokens`): the answers for 16 questions take
 *  about 1,500 tokens, so the rest is room for the model's thinking. */
export const VERIFY_TOKENS = { max: 8000, reasoning: 4000 } as const;

export async function circuitVerifyHandler(
  input: Record<string, unknown>,
  ownerId: string,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  const circuit = str(input.circuit).trim();
  if (!circuit) {
    return {
      ok: false,
      error:
        "circuit is required: the circuit's name as the drawings write it, e.g. '10000-001-01' (the part after 'Circuit ' in the layer name).",
    };
  }
  const { register, cut } = registerOf(input.register);
  let kinds: CheckKind[] | undefined;
  if (input.kinds !== undefined && input.kinds !== null) {
    const given = (Array.isArray(input.kinds) ? input.kinds : [input.kinds]).map((k) =>
      str(k).trim().toLowerCase(),
    );
    kinds = given.filter((k): k is CheckKind => CHECK_KINDS.includes(k as CheckKind));
    if (given.length && !kinds.length) {
      return {
        ok: false,
        error: `kinds named no kind of guess (got ${given
          .slice(0, 4)
          .map((k) => `'${k.slice(0, 20)}'`)
          .join(
            ', ',
          )}): use any of ${CHECK_KINDS.map((k) => `'${k}'`).join(', ')}, or leave kinds out for all.`,
      };
    }
  }
  let max = VERIFY_DEFAULT_QUESTIONS;
  if (input.max_questions !== undefined && input.max_questions !== null) {
    const n = Number(input.max_questions);
    if (!Number.isFinite(n) || n < 1) {
      return {
        ok: false,
        error: `max_questions must be a whole number from 1 to ${VERIFY_MAX.questions} (got ${JSON.stringify(input.max_questions).slice(0, 20)}); leave it out for ${VERIFY_DEFAULT_QUESTIONS}, or use dry_run to list the questions without asking.`,
      };
    }
    max = Math.min(Math.floor(n), VERIFY_MAX.questions);
  }
  // Who calls: the Checks rows' By column, which the guard against a second
  // call reads (verify.ts verifyAgainRefusal).
  const by = callerOf();
  // The resolved worker and its key, for the asks of this call only.
  let route: { worker: AiWorker; credential: ProviderCredential } | null = null;
  try {
    const r = await verifyCircuit(
      ownerId,
      {
        circuit,
        ...(register ? { register } : {}),
        ...(kinds?.length ? { kinds } : {}),
        maxQuestions: max,
        dryRun: verifyFlag(input.dry_run),
        recheck: verifyFlag(input.recheck),
        by,
      },
      {
        readSheets: readCircuitSheets,
        fileBytes: async (owner, fileId) =>
          (await readFileById({ ownerId: owner, fileId }))?.bytes ?? null,
        crop: mediaDwgCrop,
        worker: async (owner) => {
          // The one resolution (@mantle/api-keys, as runVisionWorker); a
          // provider that cannot take several images is refused by verify
          // before its key is opened.
          const r = await resolveDefaultWorker(owner, 'vision', (w) =>
            multiImageProvider(w.provider),
          );
          if (!r.ok) {
            if (r.why === 'unusable') {
              const w = r.worker;
              return {
                ok: true,
                worker: { slug: w.slug, provider: w.provider, model: w.model },
                multiImage: false,
              };
            }
            return {
              ok: false,
              error:
                r.why === 'none'
                  ? 'No vision worker is set up: add one in Settings > AI workers (an OpenRouter model that reads images), then call again.'
                  : r.why === 'no_key'
                    ? `The default vision worker '${r.worker.slug}' has no API key attached; attach one in Settings > AI workers, then call again.`
                    : `The API key of the default vision worker '${r.worker.slug}' could not be read; check it in Settings > API keys, then call again.`,
            };
          }
          route = { worker: r.worker, credential: r.credential };
          return {
            ok: true,
            worker: { slug: r.worker.slug, provider: r.worker.provider, model: r.worker.model },
            multiImage: true,
          };
        },
        ask: async (images, prompt) => {
          const { worker, credential } = route!;
          // The prompt carries every instruction the check needs (the
          // guard and the reply's JSON shape: promptFor); the worker's own
          // system prompt, when it has one, only rides along.
          const r = await extractImages(
            worker.provider,
            images,
            {
              ...credential,
              mimeType: 'image/png',
              prompt,
              ...(worker.systemPrompt ? { systemPrompt: worker.systemPrompt } : {}),
              model: worker.model,
              maxTokens: VERIFY_TOKENS.max,
            },
            { reasoningMaxTokens: VERIFY_TOKENS.reasoning },
          );
          void bumpWorkerUsage(worker.id);
          return r;
        },
        storable: storeRefusal,
        store: (owner, sheet, c, answers, overview, checkedAt) =>
          storeChecks(owner, sheet, c, answers, overview, checkedAt, by),
        now: () => new Date(),
      },
    );
    if (r.ok && cut.length) (r.output.limits as string[] | undefined)?.push(...cut);
    return r;
  } catch (err) {
    return { ok: false, error: `circuit_verify failed: ${errorMessage(err)}` };
  }
}

/** Who runs a circuit_verify call, as its Checks rows record it: the login
 *  (`login:<id>`), an assistant, the system, or the kind of caller. Never
 *  empty, so rows filed before the By column (empty) are nobody's. */
export function callerOf(): string {
  const a = currentActor();
  if (!a) return 'owner';
  switch (a.kind) {
    case 'login':
      return `login:${a.loginId}`;
    case 'assistant':
      return `assistant:${a.agentId ?? 'none'}`;
    case 'system':
      return `system:${a.reason}`;
    case 'peer':
      return `peer:${a.peerId ?? 'none'}`;
    default:
      return a.kind;
  }
}

/** Questions asked when the call does not say. */
export const VERIFY_DEFAULT_QUESTIONS = 20;

const circuit_verify: BuiltinToolDef = {
  slug: 'circuit_verify',
  policy: {
    effect: 'write',
    matrix: {
      none: 'checks one circuit across every drawing table the caller reads; writes only the Checks tab of a table it may edit, and crop files',
    },
    spends: 'ownerKey',
    startsModelWork: true,
    scope: 'any',
    keyArea: 'tables',
    // Drawing text reaches the result as in circuit_trace: fenced as data.
    outside: { untrusted: true },
    peerRisky: true,
    memberApp: 'refused',
    // Explicit calls only: never a recipe step or a run item.
    recipe: { step: 'forbidden', runItem: 'banned' },
    clientSourced: CS.always("spends the owner's vision key and writes check rows"),
  },
  name: 'Check a traced circuit with an image model',
  description: `Ask a vision model about each guess of \`circuit_trace\` on one circuit: every inferred join, end only near equipment, guessed sheet link and block-name valve type is a yes/no question on a close-up crop; a no names what it is from a closed list. Answers and crops go to the drawing table's Checks tab; trace again to draw them, never certain. **Spends the owner's vision key**, never automatic; \`dry_run\` is free. ${VERIFY_ONCE}`,
  inputSchema: {
    type: 'object',
    properties: {
      circuit: {
        type: 'string',
        description:
          "The circuit's name exactly as the layer writes it after 'Circuit ', e.g. '10000-001-01'.",
      },
      register: REGISTER_SCHEMA,
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...CHECK_KINDS] },
        uniqueItems: true,
        description:
          "Which guesses to ask about: 'join' (inferred joins), 'end' (ends only near equipment), 'link' (guessed sheet links), 'valve' (valve types read from block names). Leave it out for all.",
      },
      max_questions: {
        type: 'integer',
        minimum: 1,
        maximum: VERIFY_MAX.questions,
        default: VERIFY_DEFAULT_QUESTIONS,
        description: 'Questions to ask in this call; the rest are counted in `limits`.',
      },
      dry_run: {
        type: 'boolean',
        description: 'List the questions only: no crops, no model call, nothing stored.',
      },
      recheck: {
        type: 'boolean',
        description:
          "Ask again guesses already answered at the drawing's current revision (by default they are skipped and the next unanswered ones asked).",
      },
    },
    required: ['circuit'],
  },
  handler: (input, ctx) => circuitVerifyHandler(input, ctx.ownerId),
};

export const CIRCUIT_TOOLS: BuiltinToolDef[] = [circuit_trace, circuit_verify];
export const CIRCUIT_TOOL_SLUGS: readonly string[] = CIRCUIT_TOOLS.map((t) => t.slug);
