/**
 * circuit_verify, the run: trace the circuit, turn its guesses into
 * questions (./check.ts), crop the drawings (one sidecar call per sheet),
 * ask the vision model in as few requests as the caps allow, and file
 * every answer with its evidence in the sheet's Checks tab
 * (./checks-store.ts).
 *
 * Nothing is spent on what could not be kept: before the first vision
 * request every sheet is asked whether its answers can be filed (the
 * caller's edit right on its table, a writable table with no draft, a crop
 * folder it may create in) and whether its table still matches the
 * drawing's bytes (a file replaced in place keeps old geometry until
 * dwg-reindex). A sheet that fails either is not asked, said in
 * `not_asked`; a call where no sheet passes is refused.
 *
 * Every outside effect comes through `deps`, so the test runs the whole
 * flow with a fake sidecar, model and store: no test ever calls a model.
 * Spends only when called: nothing here runs on its own.
 */
import { createHash } from 'node:crypto';
import type { DwgCrops, MediaResult } from '@mantle/files';
import type { ImagesResult, VisionImage } from '@mantle/voice';
import {
  batchesFor,
  cropSpecFor,
  currentAnswer,
  latestBySheet,
  promptFor,
  parseAnswers,
  questionsFor,
  quoted,
  TRUST,
  VERIFY_MAX,
  type CheckKind,
  type CheckQuestion,
  type Verdict,
} from './check';
import type { ChainRole } from './pid';
import { traceCircuit, type RegisterInput, type SheetInput } from './walk';

export type VerifyWorker = {
  slug: string;
  provider: string;
  model: string;
};

/** One answered question, with its evidence. */
export type CheckAnswer = {
  q: CheckQuestion;
  verdict: Verdict;
  reason: string;
  /** The model that answered (the provider's id when it names one). */
  model: string;
  crops: { png: Buffer; part: number; of: number; window: number[]; textPx: number | null }[];
};

export type VerifyDeps = {
  readSheets: (
    ownerId: string,
    circuit: string,
  ) => Promise<{ sheets: SheetInput[]; limits: string[] }>;
  fileBytes: (ownerId: string, fileId: string) => Promise<Buffer | null>;
  crop: (
    bytes: Buffer,
    spec: import('@mantle/files').DwgCropSpec,
  ) => Promise<MediaResult<DwgCrops>>;
  /** The owner's default vision worker. */
  worker: (
    ownerId: string,
  ) => Promise<
    { ok: true; worker: VerifyWorker; multiImage: boolean } | { ok: false; error: string }
  >;
  ask: (images: VisionImage[], prompt: string) => Promise<ImagesResult>;
  /** Why this caller could not file answers about the sheet (null: it
   *  can). Asked before any vision request. */
  storable: (ownerId: string, sheet: SheetInput) => Promise<string | null>;
  /** File one sheet's answers (crops and Checks rows); the count stored,
   *  or why not. */
  store: (
    ownerId: string,
    sheet: SheetInput,
    circuit: string,
    answers: CheckAnswer[],
    overview: Buffer | null,
    checkedAt: string,
  ) => Promise<{ stored: number } | { error: string }>;
  now: () => Date;
};

export type VerifyInput = {
  circuit: string;
  register?: RegisterInput;
  kinds?: CheckKind[];
  maxQuestions?: number;
  dryRun?: boolean;
  /** Ask again guesses already answered at the drawing's current revision. */
  recheck?: boolean;
};

const plural = (n: number, w: string) =>
  `${n} ${w}${n === 1 ? '' : /(s|sh|ch|x)$/.test(w) ? 'es' : 's'}`;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The command that rebuilds one drawing's table from its file now. */
const reindexHint = (fileId: string | null) =>
  `pnpm maintain dwg-reindex --file=${fileId ?? '<file id>'} --again --apply`;

/** Why a sheet's table no longer matches its drawing, or null. */
function sourceRefusal(s: SheetInput): string | null {
  if (s.source === 'stale')
    return `its drawing file was replaced after its table was built, so the table's geometry is an older revision; an owner rebuilds it with \`${reindexHint(s.sourceFileId)}\` (no model pass), then call again`;
  if (s.source !== 'current')
    return `its table was imported before tables recorded which revision of the drawing they hold, so an answer could be filed under the wrong revision; an owner rebuilds it with \`${reindexHint(s.sourceFileId)}\` (no model pass), then call again`;
  return null;
}

/** A thrown provider timeout (providerFetch's TimeoutError). */
const isTimeout = (err: unknown) =>
  err instanceof Error && (err.name === 'TimeoutError' || /timed out/i.test(err.message));

export async function verifyCircuit(
  ownerId: string,
  input: VerifyInput,
  deps: VerifyDeps,
): Promise<{ ok: true; output: Record<string, unknown> } | { ok: false; error: string }> {
  const { circuit } = input;
  const read = await deps.readSheets(ownerId, circuit);
  const limits = [...read.limits];
  const roles = new Map<string, ChainRole>();
  const trace = traceCircuit(circuit, read.sheets, input.register, { roles });
  // Guesses already answered (sealed, this revision, the same question)
  // are not asked again unless `recheck`.
  const { latest } = latestBySheet(read.sheets);
  const {
    questions: picked,
    left,
    answered,
  } = questionsFor(trace.sheets, trace.links, read.sheets, {
    kinds: input.kinds,
    max: input.maxQuestions,
    ...(input.recheck ? {} : { answered: (q) => currentAnswer(latest, q) !== undefined }),
  });
  if (answered) {
    limits.push(
      `${plural(answered, 'guess')} already answered at this revision of the drawing ${answered === 1 ? 'was' : 'were'} not asked again (circuit_trace shows the answers; recheck: true asks again).`,
    );
  }
  if (left) {
    limits.push(
      `${plural(left, 'more guess')} past max_questions ${left === 1 ? 'was' : 'were'} not asked; call again (answered guesses are skipped, so the next call reaches them), or pick with kinds.`,
    );
  }
  const listed = (qs: readonly CheckQuestion[]) =>
    qs.map((q) => ({
      id: q.id,
      sheet: q.sheet,
      kind: q.kind,
      ...(q.node !== null ? { node: q.node } : {}),
      guess: q.guess,
      question: q.question,
    }));
  if (!picked.length) {
    return {
      ok: true,
      output: {
        summary: `Circuit ${circuit}: no ${answered ? 'unanswered ' : ''}guess the image check asks about${trace.sheets.length ? '' : ' (no readable drawing has this circuit)'}; nothing was spent.`,
        questions: [],
        limits: [...limits, ...trace.limits],
      },
    };
  }

  // Before any spend: can each sheet's answers be kept, and is its table
  // still the drawing's current revision?
  const inputOf = new Map(read.sheets.map((s) => [s.tableId, s]));
  const notAsked: { id: string; why: string }[] = [];
  const refused = new Map<string, string>();
  for (const tableId of new Set(picked.map((q) => q.tableId))) {
    const sin = inputOf.get(tableId)!;
    const why =
      sourceRefusal(sin) ??
      (await deps.storable(ownerId, sin).catch(
        (err: unknown) =>
          `could not be checked for storing (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`,
      ));
    if (why) refused.set(tableId, why);
  }
  for (const q of picked) {
    const why = refused.get(q.tableId);
    if (why) notAsked.push({ id: q.id, why });
  }
  const questions = picked.filter((q) => !refused.has(q.tableId));
  const refusedLines = [...refused].map(([id, why]) => `${inputOf.get(id)!.title}: ${why}`);

  if (input.dryRun) {
    return {
      ok: true,
      output: {
        summary: `Circuit ${circuit}: ${plural(questions.length, 'question')} would be asked on ${plural(new Set(questions.map((q) => q.tableId)).size, 'sheet')}${notAsked.length ? `; ${notAsked.length} could not be (see not_asked)` : ''} (dry run: nothing cropped, nothing spent).`,
        questions: listed(picked),
        ...(notAsked.length ? { not_asked: notAsked } : {}),
        limits,
      },
    };
  }
  if (!questions.length) {
    return {
      ok: false,
      error: `circuit_verify asked nothing and spent nothing: no sheet of circuit ${circuit} can be checked now. ${refusedLines.join(' ')} Use dry_run to list the questions.`,
    };
  }

  const resolved = await deps.worker(ownerId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { worker } = resolved;
  if (!resolved.multiImage) {
    return {
      ok: false,
      error: `circuit_verify sends several crops in one request, which the '${worker.provider}' provider of the default vision worker '${worker.slug}' does not take here. Point the default vision worker at an OpenRouter model in Settings > AI workers, then call again.`,
    };
  }

  const answers: CheckAnswer[] = [];
  const overviews = new Map<string, Buffer | null>();
  let cropsUsed = 0;
  let requests = 0;
  let timedOut = 0;
  let cutOff = 0;
  // What the replies said they used, for the result only (the spend itself
  // is recorded by the vision call, @mantle/voice vision-images.ts).
  const usage = { tokensIn: 0, tokensOut: 0 };
  const sheetOrder = [...new Set(questions.map((q) => q.tableId))];

  for (const tableId of sheetOrder) {
    const sheet = trace.sheets.find((s) => s.tableId === tableId)!;
    const sin = inputOf.get(tableId)!;
    const qs = questions.filter((q) => q.tableId === tableId);
    const skip = (why: string, list = qs) => {
      for (const q of list) notAsked.push({ id: q.id, why });
    };
    if (requests >= VERIFY_MAX.requests) {
      skip(`the request cap (${VERIFY_MAX.requests} per call) was reached`);
      continue;
    }
    if (cropsUsed >= VERIFY_MAX.crops) {
      skip(`the crop cap (${VERIFY_MAX.crops} per call) was reached`);
      continue;
    }
    if (!sin.sourceFileId) {
      skip('its table names no source drawing to crop');
      continue;
    }
    const bytes = await deps.fileBytes(ownerId, sin.sourceFileId);
    if (!bytes) {
      skip('the drawing file could not be read');
      continue;
    }
    // The bytes cropped must be the revision the table holds (a file
    // replaced since the read is caught here, before any spend).
    if (sin.sourceSha && sha256(bytes) !== sin.sourceSha) {
      skip(
        sourceRefusal({ ...sin, source: 'stale' }) ?? 'the drawing changed since its table was built',
      );
      continue;
    }
    const { spec, cut } = cropSpecFor(sheet, sin, qs, roles);
    if (cut) {
      limits.push(
        `${sin.title}: ${plural(cut, 'segment')} of the traced circuit were left off the crops' overlay (the crop request's size cap, farthest from the questions first); the crops show the drawing there without the trace drawn over it.`,
      );
    }
    const cropped = await deps.crop(bytes, spec);
    if (!cropped.ok) {
      const old = /unknown route/.test(cropped.message);
      skip(
        old
          ? 'the media sidecar has no crop endpoint (an image older than this release): update the mantle-media image'
          : `the drawing could not be cropped (${cropped.code}: ${cropped.message.slice(0, 160)})`,
      );
      continue;
    }
    const cropsOf = new Map<string, DwgCrops['crops']>();
    for (const c of cropped.value.crops) {
      const l = cropsOf.get(c.id);
      if (l) l.push(c);
      else cropsOf.set(c.id, [c]);
    }
    for (const id of cropped.value.capped) {
      const q = qs.find((x) => x.id === id);
      if (q && !cropsOf.has(id)) skip("the sidecar's crop budget for one sheet ran out", [q]);
    }
    const overview = cropped.value.overview?.png ?? null;
    overviews.set(tableId, overview);
    // The call's crop cap: questions past it are not asked.
    const room: CheckQuestion[] = [];
    for (const q of qs) {
      const n = cropsOf.get(q.id)?.length ?? 0;
      if (!n) continue;
      if (cropsUsed + n > VERIFY_MAX.crops) {
        skip(`the crop cap (${VERIFY_MAX.crops} per call) was reached`, [q]);
        continue;
      }
      cropsUsed += n;
      room.push(q);
    }
    for (const batch of batchesFor(tableId, room, (q) => cropsOf.get(q.id)?.length ?? 0)) {
      if (requests >= VERIFY_MAX.requests) {
        skip(
          `the request cap (${VERIFY_MAX.requests} per call) was reached`,
          batch.questions.map((b) => b.q),
        );
        continue;
      }
      const images: VisionImage[] = [];
      if (overview)
        images.push({
          bytes: overview,
          mimeType: 'image/png',
          caption: `Image 1: overview of the sheet named ${quoted(sheet.title)}.`,
        });
      let k = images.length + 1;
      for (const { q } of batch.questions) {
        const list = cropsOf.get(q.id)!;
        for (const c of list) {
          images.push({
            bytes: c.png,
            mimeType: 'image/png',
            caption: `Image ${k}: ${q.id}, crop ${c.part + 1} of ${c.of}.`,
          });
          k += 1;
        }
      }
      const prompt = promptFor(batch, overview !== null);
      requests += 1;
      let reply: ImagesResult;
      try {
        reply = await deps.ask(images, prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : 'error';
        if (isTimeout(err)) {
          timedOut += 1;
          skip(
            `the vision request timed out (${msg}); the provider may still bill it, and no usage came back to record`,
            batch.questions.map((b) => b.q),
          );
        } else {
          skip(
            `the vision request failed (${msg})`,
            batch.questions.map((b) => b.q),
          );
        }
        continue;
      }
      usage.tokensIn += reply.tokensIn ?? 0;
      usage.tokensOut += reply.tokensOut ?? 0;
      const truncated = reply.finishReason === 'length';
      const empty = !reply.text.trim();
      if (truncated || empty) cutOff += 1;
      const parsed = parseAnswers(
        reply.text,
        batch.questions.map((b) => b.q.id),
        truncated ? 'cut' : empty ? 'empty' : undefined,
      );
      for (const { q } of batch.questions) {
        const a = parsed.get(q.id)!;
        answers.push({
          q,
          verdict: a.verdict,
          reason: a.reason,
          model: reply.model || worker.model,
          crops: cropsOf.get(q.id)!.map((c) => ({
            png: c.png,
            part: c.part,
            of: c.of,
            window: c.window,
            textPx: c.textPx,
          })),
        });
      }
    }
  }
  if (timedOut) {
    limits.push(
      `${plural(timedOut, 'vision request')} timed out: the provider may still bill ${timedOut === 1 ? 'it' : 'them'}, and the brain recorded no spend for ${timedOut === 1 ? 'it' : 'them'} (no usage came back); ${timedOut === 1 ? 'its' : 'their'} questions are in not_asked.`,
    );
  }
  if (cutOff) {
    limits.push(
      `${plural(cutOff, 'reply')} came back cut off or empty (the model's token cap): the questions it did not answer are unsure, "model answer cut off"; ask fewer at a time with max_questions.`,
    );
  }

  // File the answers, sheet by sheet: the evidence stays with the drawing.
  const checkedAt = deps.now().toISOString();
  let stored = 0;
  for (const tableId of sheetOrder) {
    const mine = answers.filter((a) => a.q.tableId === tableId);
    if (!mine.length) continue;
    const sin = inputOf.get(tableId)!;
    const r = await deps
      .store(ownerId, sin, circuit, mine, overviews.get(tableId) ?? null, checkedAt)
      .catch((err: unknown) => ({
        error: err instanceof Error ? err.message.slice(0, 200) : 'error',
      }));
    if ('error' in r)
      limits.push(
        `${sin.title}: the answers could not be stored in its Checks tab (${r.error}); they are only in this result.`,
      );
    else stored += r.stored;
  }

  const n = (v: Verdict) => answers.filter((a) => a.verdict === v).length;
  return {
    ok: true,
    output: {
      summary:
        `Circuit ${circuit}: ${plural(answers.length, 'guess')} checked by image in ${plural(requests, 'request')} (${plural(cropsUsed, 'crop')}): ${n('yes')} confirmed, ${n('no')} contradicted, ${n('unsure')} unsure` +
        (notAsked.length ? `; ${notAsked.length} not asked (see not_asked)` : '') +
        `. ${stored ? `Stored in the Checks tab of each sheet's table, with the crops.` : 'Nothing was stored.'} A confirmed guess is CHECKED BY IMAGE, never certain.`,
      worker: { slug: worker.slug, model: worker.model },
      answers: answers.map((a) => ({
        id: a.q.id,
        sheet: a.q.sheet,
        kind: a.q.kind,
        ...(a.q.node !== null ? { node: a.q.node } : {}),
        guess: a.q.guess,
        answer: a.verdict,
        trust: TRUST[a.verdict],
        reason: a.reason,
        model: a.model,
        crops: a.crops.length,
      })),
      ...(notAsked.length ? { not_asked: notAsked } : {}),
      usage: {
        requests,
        crops: cropsUsed,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        ...(timedOut ? { timed_out: timedOut } : {}),
      },
      limits,
      next: 'circuit_trace now marks these on the drawing: CHECKED BY IMAGE for a confirmed guess; a contradicted or unsure one stays GUESS.',
    },
  };
}
