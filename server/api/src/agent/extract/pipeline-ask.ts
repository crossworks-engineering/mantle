/**
 * The paid ask of an Agent pipeline (docs/pipelines.md, "Agents"): the ONE
 * place an Agent's ask becomes a model call, with every guard in it. The
 * run job gives this function to the Agent's run (runAgentOnFile,
 * @mantle/content/file-database); nothing else may call a model for an
 * Agent's ask. (The PDF router's decider asks a model elsewhere, at upload,
 * by design: it is no Agent's ask.)
 *
 * Before a paid call, in this order:
 *  1. The pipeline is not off in the file's home workspace, now. The tool
 *     or the upload's build checked it at the queueing; this is the check at the time of spend.
 *  2. The file may have model work (`llmWorkAllowed`).
 *  3. The day cap of the box is not reached (pipelineAsksToday).
 * Guards 1 and 2 are read one time for a run. Each "no" is the answer
 * `not_available` with a reason word: `off`, `no_llm_work`, `day_cap`,
 * `no_worker`. The run stops at the first one. A run stopped at the day
 * cap is deferred, not dropped: the run job sends it again once the cap has
 * room (extract-queue.ts, pipeline-asks.ts pipelineAsksFreeAt), and it asks
 * only what its tab does not hold yet. No other stop is tried again by
 * itself.
 *
 * The provider is the cap (owner decision 2026-11-19): a provider's "not
 * now" (a rate limit, no credit, busy: @mantle/std provider-wait.ts) is the
 * answer `not_available` with the word `provider_<reason>`. The run stops
 * there (no more calls into a refusal), keeps what it paid for, and the run
 * job sends it again later with a growing gap. Such a refused call is no
 * step of the day count: the provider billed nothing.
 *
 * The call: the box's vision worker, with a fixed system text and the
 * core's question (the step gives fields, never free text). The model has
 * no tool. An ask with the list part has its own fixed system text and a
 * larger answer cap; its list is checked as data (askAnswerOf). One trace step for each call, with `meta.use` = PIPELINE_ASK_USE:
 * the adapter writes the spend on it (docs/spend-recording.md), and the day
 * count reads it. An answer that is no JSON object is `failed`.
 *
 * A scanned page of a book (an ask of an Agent of page text with the page
 * as a one-page PDF and its line count: `ask.pdf`, `ask.scan`) is read by
 * the Scan reader alone (docs/ai-workers.md, "The Scan reader"; owner
 * decisions 2026-11-19: no local OCR first, no vision backup): one call,
 * its own step of the day count. A read the check judges good is the page's
 * text (the row's Model `scan_reader:mistral-ocr`); a read judged bad is a
 * row with no text, so the page stays unread and a run again pays nothing
 * for it. A page the engine finds mostly a figure goes on to the vision
 * call above (a description of the figure), behind the same guards; when
 * that call waits (the provider's "not now", the day cap), the paid Scan
 * reader read is kept on the file as a figure (keepBookPage), so the run
 * again makes only the vision call. With no
 * Scan reader on the brain the page is skipped with no stop (unread, said
 * so) and the run's other pages go on. The decider's `scan_read_check` is
 * asked where its answer can matter: in shadow it is only logged; live, it
 * stands for the `unverified` rule.
 */
import { llmWorkAllowed } from '@mantle/db';
import type { PipelineCallAnswer, PipelineManifest } from '@mantle/files';
import { readFileRowNow } from '@mantle/content/file-database';
import {
  ASK_LIST_SYSTEM_TEXT,
  ASK_SYSTEM_TEXT,
  askAnswerOf,
  askQuestionOf,
  ASK_SKIPPED_NO_SCAN_READER,
  DAY_CAP_STOP,
  PAGE_TEXT_ANSWER_MAX_CHARS,
  providerWaitOfStop,
  providerWaitStop,
  type AgentAsk,
  type AgentAskFn,
} from '@mantle/content/pipeline-agent';
import {
  PIPELINE_ASK_USE,
  pipelineAsksDayCap,
  pipelineAsksToday,
} from '@mantle/content/pipeline-asks';
import { pipelineOffHere, pipelineStateOf } from '@mantle/content/pipeline-state';
import { checkScanRead } from '@mantle/decisions';
import {
  bookScanTurn,
  keepBookPage,
  runScanReader,
  runVisionWorker,
  scanVerdictOf,
  SCAN_READER_ENGINE,
  type BookScanTurn,
  type ScanPage,
} from '@mantle/runtime/agent';
import { PAGE_ASK_KEY_PREFIX } from '@mantle/files';
import { step } from '@mantle/tracing';

/** The prefix of the Model of a page row the Scan reader read: the honest
 *  record of which reader read a page (`scan_reader:mistral-ocr`). */
export const SCAN_READER_MODEL_PREFIX = 'scan_reader:';

/** Under this many characters (not spaces) with a figure found, a scanned
 *  page is mostly a figure (one rule for a book and the core's scans:
 *  @mantle/runtime scan-pdf.ts). */
export { FIGURE_TEXT_MAX_CHARS } from '@mantle/runtime/agent';

/** The longest answer of one ask, in tokens: the fields alone, and the
 *  fields with the list part (PIPELINE_ASK_LIST_MAX items of a short text
 *  and a class each). */
export const ANSWER_MAX_TOKENS = 1500;
export const LIST_ANSWER_MAX_TOKENS = 12_000;

const no = (reason: string): PipelineCallAnswer => ({
  ok: false,
  error: 'not_available',
  reason,
});

/** What the guards and the call read: stand-ins in a test. */
export type PipelineAskDeps = {
  offHere(): Promise<boolean>;
  llmAllowed(): Promise<boolean>;
  asksToday(): Promise<number>;
  dayCap(): number;
  vision: typeof runVisionWorker;
  scan: typeof runScanReader;
  check: typeof checkScanRead;
  /** The shared reads of one page (bookScanTurn). */
  shared(page: number): Promise<BookScanTurn>;
  /** Keep one page of the file in the shared reads (keepBookPage). */
  keep(page: ScanPage): Promise<void>;
};

/**
 * The ask of one run of `pipeline` on the file `nodeId`. `deps`: the
 * guards' readers, for a test; left out, the box's own.
 */
export function pipelineAskOf(
  ownerId: string,
  nodeId: string,
  pipeline: PipelineManifest,
  deps: Partial<PipelineAskDeps> = {},
): AgentAskFn {
  const d: PipelineAskDeps = {
    offHere: async () => {
      const state = await pipelineStateOf(ownerId, pipeline);
      const now = await readFileRowNow(nodeId, ownerId);
      return !now || pipelineOffHere(state, now.home);
    },
    llmAllowed: () => llmWorkAllowed(nodeId),
    asksToday: () => pipelineAsksToday(ownerId),
    dayCap: pipelineAsksDayCap,
    vision: runVisionWorker,
    scan: runScanReader,
    check: checkScanRead,
    shared: (page) => bookScanTurn(nodeId, page),
    keep: (page) => keepBookPage(nodeId, page),
    ...deps,
  };
  // Guards 1 and 2, read one time for the run.
  let fixed: Promise<string | null> | undefined;
  const fixedNo = () =>
    (fixed ??= (async () => {
      if (await d.offHere()) return 'off';
      if (!(await d.llmAllowed())) return 'no_llm_work';
      return null;
    })());

  // An Agent of page text (`produces.pages`, pdf-page-read) asks for a whole
  // page: the token cap of a list ask, and a page's text, not a cell's. At
  // 1,500 tokens a dense page's JSON is cut, a failed ask that stops the run.
  const pageText = pipeline.produces?.pages === true;
  /**
   * The Scan reader's read of a scanned page: its text when the check
   * judges it good; an answer with no text when judged bad (the page stays
   * unread, and a run again takes this row by hash: no second paid read);
   * `figure` when the engine found a figure and next to no text (vision
   * describes it); a skip with no stop when the brain has no Scan reader; a
   * failure when the provider failed.
   */
  const scanRead = (ask: AgentAsk, scan: NonNullable<AgentAsk['scan']>, pdf: Buffer) =>
    step(
      {
        name: 'pipeline_ask',
        kind: 'llm_call',
        input: {
          pipeline: pipeline.id,
          key: ask.key,
          reader: 'scan_reader',
          mime: 'application/pdf',
          bytes: pdf.length,
        },
      },
      async (h): Promise<PipelineCallAnswer | 'figure'> => {
        const out = await d.scan({
          ownerId,
          pdf,
          ...(scan.lines !== null ? { expectedLines: scan.lines } : {}),
          tries: 2,
        });
        // No Scan reader the box can use (none, no key, no engine): no call,
        // not one of the day count; the page stays unread, the run goes on.
        if (!out.attempted) {
          h.setSkipped(ASK_SKIPPED_NO_SCAN_READER);
          h.setMeta({ reader: 'scan_reader', note: out.note });
          return { ok: false, error: 'not_available', reason: ASK_SKIPPED_NO_SCAN_READER };
        }
        // The provider said "not now": no step of the day count (nothing
        // billed), the page is not judged, and the run waits.
        if (!out.ran && out.wait) {
          h.setSkipped(providerWaitStop(out.wait.reason));
          h.setMeta({ reader: 'scan_reader', wait: out.wait.reason, note: out.note });
          return no(providerWaitStop(out.wait.reason));
        }
        h.setMeta({
          // A call went out: one of the day count (a provider that failed
          // may bill it).
          use: PIPELINE_ASK_USE,
          pipeline: pipeline.id,
          reader: 'scan_reader',
          engine: out.engine,
          ran: out.ran,
          note: out.note,
          textLength: out.text.length,
          pictures: out.pictures,
          quality: out.quality.reasons,
        });
        if (!out.ran) {
          h.setError(out.note ?? 'no answer');
          return { ok: false, error: 'failed', reason: 'scan_reader_failed' };
        }
        // The verdict, the core's scanned PDFs' too (scanVerdictOf): mostly
        // a figure (the engine found a picture and next to no text) goes on
        // to vision (a picture description, not a second read); else the
        // free check, with the decider asked where no free rule can vouch
        // for the read (shadow: logged; live: it stands for `unverified`).
        const v = await scanVerdictOf(
          ownerId,
          out,
          async () => ({ bytes: ask.picture, mimeType: ask.mime }),
          d.check,
        );
        if (v.check) h.setMeta({ check: { faithful: v.check.faithful, mode: v.check.mode } });
        if (v.verdict === 'figure') {
          h.setMeta({ judged: 'figure' });
          return 'figure';
        }
        const good = v.verdict === 'good';
        h.setMeta({ judged: good ? 'good' : 'bad' });
        const name = ask.fields[0]!.name;
        const model = `${SCAN_READER_MODEL_PREFIX}${out.engine}`;
        // Judged bad: the page stays unread (no text), recorded so a run
        // again pays nothing for it.
        if (!good) return { ok: true, output: { values: { [name]: null }, model } };
        return {
          ok: true,
          output: { values: { [name]: out.text.slice(0, PAGE_TEXT_ANSWER_MAX_CHARS) }, model },
        };
      },
    );

  return async (ask: AgentAsk): Promise<PipelineCallAnswer> => {
    const why = await fixedNo();
    if (why) return no(why);
    if ((await d.asksToday()) >= d.dayCap()) return no(DAY_CAP_STOP);
    // A scanned page (one field, the page's text, with its PDF and line
    // count): the Scan reader alone. Vision only for a figure.
    // The page's read may be shared with a chat turn on the same upload
    // (@mantle/runtime scan-share.ts, "Share the reads"): a page it kept is
    // the answer with no call; while it reads the file, the page is claimed
    // first, and this read is kept for it.
    let shared: Extract<BookScanTurn, { hooks: unknown }> | null = null;
    // A figure page: its Scan reader read kept by a reader before (this
    // ask makes only the vision call), or paid by this ask.
    let keptFigure = false;
    let paidFigure = false;
    const page = pageOfAskKey(ask.key);
    const figure = (n: number): ScanPage => ({
      page: n,
      method: 'unread',
      text: '',
      why: 'figure',
    });
    if (pageText && ask.pdf && ask.scan && ask.fields.length === 1 && !ask.list) {
      const name = ask.fields[0]!.name;
      const turn: BookScanTurn = page !== null ? await d.shared(page) : { alone: true };
      if ('kept' in turn) {
        const k = turn.kept;
        // A figure the chat turn's vision could not describe: this ask's
        // own vision call (its Scan reader read is not made again).
        if (!(k.method === 'unread' && k.why === 'figure')) {
          const model =
            k.method === 'vision' ? 'vision' : `${SCAN_READER_MODEL_PREFIX}${SCAN_READER_ENGINE}`;
          return {
            ok: true,
            output: {
              values: { [name]: k.text ? k.text.slice(0, PAGE_TEXT_ANSWER_MAX_CHARS) : null },
              model,
            },
          };
        }
        keptFigure = true;
      } else {
        if ('hooks' in turn) shared = turn;
        const read = await scanRead(ask, ask.scan, ask.pdf);
        if (read !== 'figure') {
          if (shared && page !== null) await keepShared(shared, pageOfAnswer(page, read, name));
          return read;
        }
        paidFigure = true;
      }
      if ((await d.asksToday()) >= d.dayCap()) {
        // The figure's Scan reader read, paid here, is kept: the run again
        // (once the cap has room) makes only the vision call.
        if (paidFigure && page !== null) {
          if (shared) await keepShared(shared, figure(page));
          else await d.keep(figure(page));
        }
        return no(DAY_CAP_STOP);
      }
    }
    const answer = await step(
      {
        name: 'pipeline_ask',
        kind: 'llm_call',
        input: {
          pipeline: pipeline.id,
          key: ask.key,
          mime: ask.mime,
          bytes: ask.picture.length,
          ...(ask.list ? { list: true } : {}),
        },
      },
      async (h): Promise<PipelineCallAnswer> => {
        const out = await d.vision({
          ownerId,
          bytes: ask.picture,
          mimeType: ask.mime,
          systemPrompt: ask.list ? ASK_LIST_SYSTEM_TEXT : ASK_SYSTEM_TEXT,
          prompt: askQuestionOf(ask.fields, ask.list),
          maxTokens: ask.list || pageText ? LIST_ANSWER_MAX_TOKENS : ANSWER_MAX_TOKENS,
          leastThinking: true,
          // One time more when the provider failed: a failed ask stops the
          // asks after it in the run.
          tries: 2,
        });
        // No model: the box has no vision worker, so no call was made, and
        // the step is not one of the day count.
        if (!out.ran && out.model === null) {
          h.setSkipped('no_worker');
          return no('no_worker');
        }
        // The provider said "not now": no step of the day count (nothing
        // billed); the run waits and asks again later.
        if (!out.ran && out.wait) {
          h.setSkipped(providerWaitStop(out.wait.reason));
          h.setMeta({ pipeline: pipeline.id, wait: out.wait.reason, note: out.note });
          return no(providerWaitStop(out.wait.reason));
        }
        h.setMeta({
          use: PIPELINE_ASK_USE,
          pipeline: pipeline.id,
          ran: out.ran,
          note: out.note,
          adapter: out.adapterName,
          textLength: out.text.length,
        });
        if (!out.text) {
          h.setError(out.note ?? 'no text');
          return { ok: false, error: 'failed', reason: 'no_text' };
        }
        const answer = askAnswerOf(
          out.text,
          ask.fields,
          ask.list,
          pageText ? PAGE_TEXT_ANSWER_MAX_CHARS : undefined,
        );
        if (!answer) {
          h.setError('the answer is no JSON object');
          return { ok: false, error: 'failed', reason: 'no_json' };
        }
        const { cut, ...got } = answer;
        if (got.list) h.setMeta({ listItems: got.list.length, ...(cut ? { cut: true } : {}) });
        return { ok: true, output: { ...got, model: out.model ?? '' } };
      },
    );
    if (page !== null && (shared || keptFigure || paidFigure)) {
      const text = answer.ok ? valueOf(answer.output, ask.fields[0]!.name) : null;
      const described = typeof text === 'string' && text.trim() ? text : null;
      // The provider's "not now" to the vision call after this ask paid the
      // figure's Scan reader read: that read is kept (a figure), so the run
      // again makes only the vision call, never the Scan reader's again.
      const waited = paidFigure && !answer.ok && providerWaitOfStop(answer.reason) !== null;
      if (shared) {
        // A shared figure page: its description kept for the chat turn
        // (none: a figure not described, final).
        await keepShared(
          shared,
          described
            ? { page, method: 'vision', text: described }
            : answer.ok || waited
              ? figure(page)
              : { page, method: 'unread', text: '', why: 'failed' },
        );
      } else if (waited) {
        await d.keep(figure(page));
      } else if (keptFigure && described) {
        // A kept figure now described: the description in its place, for a
        // chat turn on the same upload.
        await d.keep({ page, method: 'vision', text: described });
      }
    }
    return answer;
  };
}

/** The value of field `name` in an ask's output (`{ values }`), or null. */
function valueOf(output: unknown, name: string): unknown {
  const values = (output as { values?: Record<string, unknown> } | null)?.values;
  return values?.[name] ?? null;
}

/** The page of an Agent's page ask (`page-<N>`), or null. */
function pageOfAskKey(key: string): number | null {
  if (!key.startsWith(PAGE_ASK_KEY_PREFIX)) return null;
  const n = Number(key.slice(PAGE_ASK_KEY_PREFIX.length));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** A Scan reader answer of the book's ask as a shared page: its text (read),
 *  no text (read badly), or no answer (not final: read again). */
function pageOfAnswer(page: number, read: PipelineCallAnswer, name: string): ScanPage {
  if (!read.ok) {
    return {
      page,
      method: 'unread',
      text: '',
      why: read.reason === ASK_SKIPPED_NO_SCAN_READER ? 'no_scan_reader' : 'failed',
    };
  }
  const text = valueOf(read.output, name);
  return typeof text === 'string' && text
    ? { page, method: 'scan_reader', text }
    : { page, method: 'unread', text: '', why: 'bad_read' };
}

/** Keep a shared page, which also ends the claim. Best effort: a lost write
 *  only leaves the chat turn to wait out the claim. */
async function keepShared(
  shared: { hooks: { keep(p: ScanPage[]): Promise<unknown> } },
  page: ScanPage,
): Promise<void> {
  await shared.hooks.keep([page]).catch(() => {});
}
