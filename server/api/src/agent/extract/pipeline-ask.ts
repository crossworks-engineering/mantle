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
 * `no_worker`. The run stops at the first one and starts nothing later: no
 * timer and no retry asks again.
 *
 * The call: the box's vision worker, with a fixed system text and the
 * core's question (the step gives fields, never free text). The model has
 * no tool. An ask with the list part has its own fixed system text and a
 * larger answer cap; its list is checked as data (askAnswerOf). One trace step for each call, with `meta.use` = PIPELINE_ASK_USE:
 * the adapter writes the spend on it (docs/spend-recording.md), and the day
 * count reads it. An answer that is no JSON object is `failed`.
 *
 * A page of a book OCR read badly (an ask of an Agent of page text with the
 * page as a one-page PDF and the free evidence: `ask.pdf`, `ask.scan`) is
 * read by the Scan reader first (docs/ai-workers.md, "The Scan reader"):
 * one call, its own step of the day count. A read the check judges good is
 * the page's text (the row's Model `scan_reader:<engine>`); a read judged
 * bad, a failed call, or a brain with no Scan reader goes on to the vision
 * call above, behind the same guards. On a page whose read no word of
 * Tesseract can vouch for, the decider's `scan_read_check` is asked too: in
 * shadow it is only logged; live, its answer stands for the `unverified`
 * rule. Never more than two paid reads of a page (the Scan reader, then
 * vision), and the second only when the first is judged bad.
 */
import { llmWorkAllowed } from '@mantle/db';
import type { PipelineCallAnswer, PipelineManifest } from '@mantle/files';
import { readFileRowNow } from '@mantle/content/file-database';
import {
  ASK_LIST_SYSTEM_TEXT,
  ASK_SYSTEM_TEXT,
  askAnswerOf,
  askQuestionOf,
  PAGE_TEXT_ANSWER_MAX_CHARS,
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
  runScanReader,
  runVisionWorker,
  SCAN_READ_ANCHORS_MIN,
  type OcrWord,
} from '@mantle/runtime/agent';
import { step } from '@mantle/tracing';

/** The prefix of the Model of a page row the Scan reader read: the honest
 *  record of which reader read a page (`scan_reader:mistral-ocr`). */
export const SCAN_READER_MODEL_PREFIX = 'scan_reader:';

/** The confidence a word of the evidence stands at: it was read at
 *  SURE_CONF (90) or more (pdf_pages.py). */
const SURE_CONF = 90;

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
   * The Scan reader's read of a page: the answer when the check judges it
   * good, else null (judged bad, failed, or no Scan reader worker: the page
   * goes on to vision).
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
      async (h): Promise<PipelineCallAnswer | null> => {
        const ocrWords: OcrWord[] = scan.words.map((text) => ({ text, conf: SURE_CONF }));
        const out = await d.scan({
          ownerId,
          pdf,
          picture: { bytes: ask.picture, mimeType: ask.mime },
          ocrWords,
          ...(scan.lines !== null ? { expectedLines: scan.lines } : {}),
          tries: 2,
        });
        // No Scan reader on the brain: no call, not one of the day count.
        if (!out.ran && out.model === null) {
          h.setSkipped('no_scan_reader');
          return null;
        }
        h.setMeta({
          use: PIPELINE_ASK_USE,
          pipeline: pipeline.id,
          reader: 'scan_reader',
          ran: out.ran,
          note: out.note,
          ...(out.engine ? { engine: out.engine } : {}),
          textLength: out.text.length,
          quality: out.quality.reasons,
          anchors: out.quality.anchors,
          agreement: out.quality.agreement,
        });
        if (!out.ran || !out.text) {
          h.setError(out.note ?? 'no text');
          return null;
        }
        let good = out.quality.ok;
        // No word of Tesseract can vouch for the read: the decider is asked
        // too (scan_read_check). Shadow: logged. Live: it stands for the
        // line rule `unverified`, the other reasons stay.
        if (out.quality.anchors < SCAN_READ_ANCHORS_MIN) {
          const c = await d.check(ownerId, {
            picture: ask.picture,
            mimeType: ask.mime,
            text: out.text,
          });
          if (c) {
            h.setMeta({
              check: { faithful: Math.round(c.faithful * 1000) / 1000, mode: c.mode },
            });
            if (c.used) {
              good = c.passes && out.quality.reasons.every((r) => r === 'unverified');
            }
          }
        }
        h.setMeta({ judged: good ? 'good' : 'bad' });
        if (!good) return null;
        const name = ask.fields[0]!.name;
        return {
          ok: true,
          output: {
            values: { [name]: out.text.slice(0, PAGE_TEXT_ANSWER_MAX_CHARS) },
            model: `${SCAN_READER_MODEL_PREFIX}${out.engine ?? out.model ?? ''}`,
          },
        };
      },
    );

  return async (ask: AgentAsk): Promise<PipelineCallAnswer> => {
    const why = await fixedNo();
    if (why) return no(why);
    if ((await d.asksToday()) >= d.dayCap()) return no('day_cap');
    // A page OCR read badly: the Scan reader first (one field, the page's
    // text, with its PDF and evidence). Vision only when it read badly.
    if (pageText && ask.pdf && ask.scan && ask.fields.length === 1 && !ask.list) {
      const read = await scanRead(ask, ask.scan, ask.pdf);
      if (read) return read;
      if ((await d.asksToday()) >= d.dayCap()) return no('day_cap');
    }
    return step(
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
  };
}
