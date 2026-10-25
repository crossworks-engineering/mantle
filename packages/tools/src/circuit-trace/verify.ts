/**
 * circuit_verify, the run: trace the circuit, turn its guesses into
 * questions (./check.ts), crop the drawings (one sidecar call per sheet),
 * ask the vision model in as few requests as the caps allow, and file
 * every answer with its evidence in the sheet's Checks tab
 * (./checks-store.ts).
 *
 * Every outside effect comes through `deps`, so the test runs the whole
 * flow with a fake sidecar, model and store: no test ever calls a model.
 * Spends only when called: nothing here runs on its own.
 */
import type { DwgCrops, MediaResult } from '@mantle/files';
import type { VisionExtractResult, VisionImage } from '@mantle/voice';
import {
  batchesFor,
  cropSpecFor,
  promptFor,
  parseAnswers,
  questionsFor,
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
  /** The drawing-check worker was missing: the default vision worker ran. */
  fellBack: boolean;
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
  /** The drawing-check worker (or the default vision worker). */
  worker: (
    ownerId: string,
  ) => Promise<
    { ok: true; worker: VerifyWorker; multiImage: boolean } | { ok: false; error: string }
  >;
  ask: (images: VisionImage[], prompt: string) => Promise<VisionExtractResult>;
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
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
  const { questions, left } = questionsFor(trace.sheets, trace.links, read.sheets, {
    kinds: input.kinds,
    max: input.maxQuestions,
  });
  if (left) {
    limits.push(
      `${plural(left, 'more guess')} past max_questions were not asked; call again with kinds to pick which.`,
    );
  }
  const listed = questions.map((q) => ({
    id: q.id,
    sheet: q.sheet,
    kind: q.kind,
    ...(q.node !== null ? { node: q.node } : {}),
    guess: q.guess,
    question: q.question,
  }));
  if (!questions.length) {
    return {
      ok: true,
      output: {
        summary: `Circuit ${circuit}: no guess the image check asks about${trace.sheets.length ? '' : ' (no readable drawing has this circuit)'}; nothing was spent.`,
        questions: [],
        limits: [...limits, ...trace.limits],
      },
    };
  }
  if (input.dryRun) {
    return {
      ok: true,
      output: {
        summary: `Circuit ${circuit}: ${plural(questions.length, 'question')} would be asked on ${plural(new Set(questions.map((q) => q.tableId)).size, 'sheet')} (dry run: nothing cropped, nothing spent).`,
        questions: listed,
        limits,
      },
    };
  }

  const resolved = await deps.worker(ownerId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { worker } = resolved;
  if (!resolved.multiImage) {
    return {
      ok: false,
      error: `circuit_verify sends several crops in one request, which the '${worker.provider}' provider of vision worker '${worker.slug}' does not take here. Point the drawing-check worker (or the default vision worker) at an openrouter model in Settings > AI workers, then call again.`,
    };
  }
  if (worker.fellBack) {
    limits.push(
      `no enabled drawing-check worker: the default vision worker '${worker.slug}' (${worker.model}) answered; an owner can add the drawing-check worker from Settings > Config.`,
    );
  }

  const answers: CheckAnswer[] = [];
  const notAsked: { id: string; why: string }[] = [];
  const overviews = new Map<string, Buffer | null>();
  let cropsUsed = 0;
  let requests = 0;
  // What the replies said they used, for the result only (the spend itself
  // is recorded by the vision call, @mantle/voice vision-images.ts).
  const usage = { tokensIn: 0, tokensOut: 0 };
  const inputOf = new Map(read.sheets.map((s) => [s.tableId, s]));
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
    const cropped = await deps.crop(bytes, cropSpecFor(sheet, sin, qs, roles));
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
          caption: `Image 1: overview of sheet ${sheet.title}.`,
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
      let reply: VisionExtractResult;
      try {
        reply = await deps.ask(images, prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : 'error';
        skip(
          `the vision request failed (${msg})`,
          batch.questions.map((b) => b.q),
        );
        continue;
      }
      usage.tokensIn += reply.tokensIn ?? 0;
      usage.tokensOut += reply.tokensOut ?? 0;
      const parsed = parseAnswers(
        reply.text,
        batch.questions.map((b) => b.q.id),
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

  // File the answers, sheet by sheet: the evidence stays with the drawing.
  const checkedAt = deps.now().toISOString();
  let stored = 0;
  for (const tableId of sheetOrder) {
    const mine = answers.filter((a) => a.q.tableId === tableId);
    if (!mine.length) continue;
    const sin = inputOf.get(tableId)!;
    if (!sin.revision) {
      limits.push(
        `${sin.title}: the drawing's revision could not be read, so its answers are stored but a later circuit_trace will not apply them.`,
      );
    }
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
      worker: { slug: worker.slug, model: worker.model, fell_back: worker.fellBack },
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
      usage: { requests, crops: cropsUsed, tokens_in: usage.tokensIn, tokens_out: usage.tokensOut },
      limits,
      next: 'circuit_trace now marks these on the drawing: CHECKED BY IMAGE for a confirmed guess; a contradicted or unsure one stays GUESS.',
    },
  };
}
