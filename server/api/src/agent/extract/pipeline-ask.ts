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
 *     or the build checked it at the queueing; this is the check at the time of spend.
 *  2. The file may have model work (`llmWorkAllowed`).
 *  3. The day cap of the box is not reached (pipelineAsksToday).
 * Guards 1 and 2 are read one time for a run. Each "no" is the answer
 * `not_available` with a reason word: `off`, `no_llm_work`, `day_cap`,
 * `no_worker`. The run stops at the first one and starts nothing later: no
 * timer and no retry asks again.
 *
 * The call: the box's vision worker, with a fixed system text and the
 * core's question (the step gives fields, never free text). The model has
 * no tool. One trace step for each call, with `meta.use` = PIPELINE_ASK_USE:
 * the adapter writes the spend on it (docs/spend-recording.md), and the day
 * count reads it. An answer that is no JSON object is `failed`.
 */
import { llmWorkAllowed } from '@mantle/db';
import type { PipelineCallAnswer, PipelineManifest } from '@mantle/files';
import { readFileRowNow } from '@mantle/content/file-database';
import {
  ASK_SYSTEM_TEXT,
  askQuestionOf,
  askValuesOf,
  type AgentAsk,
  type AgentAskFn,
} from '@mantle/content/pipeline-agent';
import {
  PIPELINE_ASK_USE,
  pipelineAsksDayCap,
  pipelineAsksToday,
} from '@mantle/content/pipeline-asks';
import { pipelineOffHere, pipelineStateOf } from '@mantle/content/pipeline-state';
import { runVisionWorker } from '@mantle/runtime/agent';
import { step } from '@mantle/tracing';

/** The longest answer of one ask, in tokens. */
const ANSWER_MAX_TOKENS = 1500;

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

  return async (ask: AgentAsk): Promise<PipelineCallAnswer> => {
    const why = await fixedNo();
    if (why) return no(why);
    if ((await d.asksToday()) >= d.dayCap()) return no('day_cap');
    return step(
      {
        name: 'pipeline_ask',
        kind: 'llm_call',
        input: { pipeline: pipeline.id, key: ask.key, mime: ask.mime, bytes: ask.picture.length },
      },
      async (h): Promise<PipelineCallAnswer> => {
        const out = await d.vision({
          ownerId,
          bytes: ask.picture,
          mimeType: ask.mime,
          systemPrompt: ASK_SYSTEM_TEXT,
          prompt: askQuestionOf(ask.fields),
          maxTokens: ANSWER_MAX_TOKENS,
          leastThinking: true,
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
        const values = askValuesOf(out.text, ask.fields);
        if (!values) {
          h.setError('the answer is no JSON object');
          return { ok: false, error: 'failed', reason: 'no_json' };
        }
        return { ok: true, output: { values, model: out.model ?? '' } };
      },
    );
  };
}
