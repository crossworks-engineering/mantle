/**
 * Spend recording, call path by call path (A10 #5, "record, move, compare").
 *
 * Each case drives one provider call path the way its call site does, against
 * a fake provider that returns known usage, inside a trace and a step, and
 * reads back what lands: the trace's close totals (tokens in, out, cache read,
 * cost: what rollups and the member token budget read), the step's meta (what
 * spend-by-model reads), and for a run item the cost on its item row (what the
 * run budget reads).
 *
 * This first version records MAIN as it is: three recorders (recordChatUsage,
 * captureLlmUsage, recordStepUsage), three hand cost sinks (the tool step's
 * addTokens/addCost from the tool loop, the pending path and the run item),
 * and the paths that record nothing.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracesTable: { __t: 'traces' },
  traceStepsTable: { __t: 'traceSteps' },
  traceUpdates: [] as Array<Record<string, unknown>>,
  stepUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', () => ({
  get systemDb(): unknown {
    return (this as { db: unknown }).db;
  },
  traces: h.tracesTable,
  traceSteps: h.traceStepsTable,
  db: {
    insert: () => ({ values: async () => {} }),
    update: (tbl: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        if (tbl === h.tracesTable) h.traceUpdates.push(payload);
        if (tbl === h.traceStepsTable) h.stepUpdates.push(payload);
        const done = Promise.resolve();
        return { where: () => done };
      },
    }),
  },
}));

import {
  captureLlmUsage,
  currentTrace,
  fallbackCostMicroUsd,
  recordChatUsage,
  recordStepUsage,
  startTrace,
  step,
  type StepHandle,
} from '@mantle/tracing';
import {
  getChatAdapter,
  getDecisionAdapter,
  getEmbeddingAdapter,
  getImageGenAdapter,
  getSttAdapter,
  getTtsAdapter,
  getVisionAdapter,
  registerChatAdapter,
  registerDecisionAdapter,
  registerEmbeddingAdapter,
  registerImageGenAdapter,
  registerSttAdapter,
  registerTtsAdapter,
  registerVisionAdapter,
  type ChatDispatcher,
  type DecisionDispatcher,
  type EmbeddingDispatcher,
  type ImageGenDispatcher,
  type SttDispatcher,
  type TtsDispatcher,
  type VisionDispatcher,
} from '@mantle/voice';

// ─── The fake provider: known usage on every capability ──────────────────────

/** A provider id no real adapter uses. The registry is keyed by id only. */
const P = 'spend-fake' as never;

const CHAT = {
  model: 'anthropic/claude-sonnet-4.6',
  tokensIn: 1000,
  tokensOut: 200,
  cacheReadTokens: 300,
  cacheWriteTokens: 100,
};
/** sonnet-4.6: (1000 - 300) * 3e-6 + 300 * 3e-7 + 200 * 1.5e-5 = 0.00519 USD. */
const CHAT_COST = 5190;

const fakeChat: ChatDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-chat',
  chat: async (o) => ({ text: 'ok', ...CHAT, model: o.model || CHAT.model }),
  chatStream: async (o, onDelta) => {
    onDelta({ type: 'text', text: 'ok' });
    return { text: 'ok', ...CHAT, model: o.model || CHAT.model };
  },
};
const fakeDecision: DecisionDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-decision',
  decide: async () => ({
    answers: { q: { type: 'noul', probability: 0.9 } },
    model: 'typesafe/jev-1.13',
    tokensIn: 500,
    tokensOut: 0,
    reportedCostUsd: 0.000021,
  }),
};
const fakeVision: VisionDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-vision',
  extract: async () => ({ text: 'seen', model: 'gpt-4o-mini-2024', tokensIn: 800, tokensOut: 150 }),
  extractDocument: async () => ({
    text: 'read',
    model: 'gpt-4o-mini-2024',
    tokensIn: 800,
    tokensOut: 150,
  }),
};
/** gpt-4o-mini: 800 * 1.5e-7 + 150 * 6e-7 = 0.00021 USD. */
const VISION_COST = 210;
const fakeEmbedding: EmbeddingDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-embedding',
  embed: async (req) => ({
    vectors: req.input.map(() => [0.1, 0.2]),
    model: req.model,
    tokensIn: 50,
  }),
};
const fakeImage: ImageGenDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-image',
  supports: [],
  generate: async () => ({ bytes: Buffer.from('png'), mimeType: 'image/png', model: 'img-1' }),
  staticCatalog: () => [],
};
const fakeTts: TtsDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-tts',
  supports: [],
  synthesize: async (o) => ({
    bytes: Buffer.from('ogg'),
    mimeType: 'audio/ogg',
    voice: 'nova',
    model: o.model ?? 'tts-1',
  }),
};
const fakeStt: SttDispatcher = {
  providerId: P,
  adapterName: 'spend-fake-stt',
  supports: [],
  transcribe: async () => ({ text: 'hi', language: 'en', durationSeconds: 42, model: 'whisper-1' }),
};
/** A raw OpenRouter response, as the research tool holds it. */
const RESEARCH_RAW = {
  usage: {
    prompt_tokens: 400,
    completion_tokens: 300,
    cost: 0.006,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 50 },
  },
};

beforeAll(() => {
  registerChatAdapter(fakeChat);
  registerDecisionAdapter(fakeDecision);
  registerVisionAdapter(fakeVision);
  registerEmbeddingAdapter(fakeEmbedding);
  registerImageGenAdapter(fakeImage);
  registerTtsAdapter(fakeTts);
  registerSttAdapter(fakeStt);
});

afterEach(() => {
  h.traceUpdates.length = 0;
  h.stepUpdates.length = 0;
});

// ─── Harness ─────────────────────────────────────────────────────────────────

type Recorded = {
  trace: { tokensIn: number; tokensOut: number; tokensCacheRead: number; costMicroUsd: number };
  /** The usage keys of the step the call ran in (empty: none recorded). */
  step: Record<string, unknown>;
};

const USAGE_KEYS = [
  'model',
  'tokens_in',
  'tokens_out',
  'cache_read',
  'cache_write',
  'cost_micro_usd',
  'audio_seconds',
  'characters',
  'images',
];

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Run `body` in a trace with one step around it, return what landed. */
async function recordPath(body: (handle: StepHandle) => Promise<unknown>): Promise<Recorded> {
  h.traceUpdates.length = 0;
  h.stepUpdates.length = 0;
  await startTrace({ ownerId: 'owner-1', kind: 'manual' }, () =>
    step({ name: 'the call', kind: 'llm_call' }, body),
  );
  await flush();
  const close = h.traceUpdates.find((u) => u.status === 'success')!;
  const stepClose = h.stepUpdates.find((u) => u.status === 'success')!;
  const meta = (stepClose.meta ?? {}) as Record<string, unknown>;
  return {
    trace: {
      tokensIn: close.tokensIn as number,
      tokensOut: close.tokensOut as number,
      tokensCacheRead: close.tokensCacheRead as number,
      costMicroUsd: close.costMicroUsd as number,
    },
    step: Object.fromEntries(USAGE_KEYS.filter((k) => k in meta).map((k) => [k, meta[k]])),
  };
}

const chatOpts = {
  apiKey: 'k',
  model: CHAT.model,
  messages: [{ role: 'user' as const, content: 'x' }],
};

/** The tool step sink the tool loop, the pending path and the run item hand a
 *  tool (main: execute-call.ts, pending.ts, execute-item.ts). */
function toolSink(handle: StepHandle) {
  return {
    setMeta: (m: Record<string, unknown>) => handle.setMeta(m),
    setOutput: (o: Record<string, unknown>) => handle.setOutput(o),
    addTokens: (d: { input?: number; output?: number; cacheRead?: number }) => handle.addTokens(d),
    addCost: (mu: number) => handle.addCost(mu),
  };
}

// ─── The paths ───────────────────────────────────────────────────────────────

describe('spend recording per call path (main)', () => {
  it('tool loop chat round (model-caller): recordChatUsage on the requested model', async () => {
    const got = await recordPath(async (h) => {
      const r = await getChatAdapter(P)!.chat(chatOpts);
      recordChatUsage(h, r, CHAT.model);
    });
    expect(got).toEqual({
      trace: { tokensIn: 1100, tokensOut: 200, tokensCacheRead: 300, costMicroUsd: CHAT_COST },
      step: {
        model: CHAT.model,
        tokens_in: 1000,
        tokens_out: 200,
        cache_read: 300,
        cache_write: 100,
        cost_micro_usd: CHAT_COST,
      },
    });
  });

  it('tool loop streamed round: the same', async () => {
    const got = await recordPath(async (h) => {
      const r = await getChatAdapter(P)!.chatStream!(chatOpts, () => {});
      recordChatUsage(h, r, CHAT.model);
    });
    expect(got.trace).toEqual({
      tokensIn: 1100,
      tokensOut: 200,
      tokensCacheRead: 300,
      costMicroUsd: CHAT_COST,
    });
  });

  it('worker chat (summarizer, reflector, archive, extractor): priced on the SERVED model', async () => {
    // Requested an alias the table lacks; the provider served a priced id.
    const got = await recordPath(async (h) => {
      const r = await getChatAdapter(P)!.chat({ ...chatOpts, model: '' });
      recordChatUsage(h, r, r.model || 'unpriced/alias');
    });
    expect(got.trace.costMicroUsd).toBe(CHAT_COST);
    // And requesting a priced id the provider answers under an unpriced one:
    // the served id is what is priced, so it reads $0.
    const got2 = await recordPath(async (h) => {
      const r = { ...(await getChatAdapter(P)!.chat(chatOpts)), model: 'anthropic/dated-x' };
      recordChatUsage(h, r, r.model || CHAT.model);
    });
    expect(got2.trace.costMicroUsd).toBe(0);
  });

  it('decider (decide.ts): recordChatUsage, reported cost', async () => {
    const got = await recordPath(async (h) => {
      const res = await getDecisionAdapter(P)!.decide({
        apiKey: 'k',
        model: 'typesafe/jev-1.13',
        state: {},
        questions: { q: { type: 'noul', instructions: 'x' } },
      });
      recordChatUsage(h, res, 'typesafe/jev-1.13');
    });
    expect(got).toEqual({
      trace: { tokensIn: 500, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 21 },
      step: {
        model: 'typesafe/jev-1.13',
        tokens_in: 500,
        tokens_out: 0,
        cache_read: 0,
        cost_micro_usd: 21,
      },
    });
  });

  it('vision worker (attachments runVisionWorker): recordStepUsage on the configured model', async () => {
    const got = await recordPath(async () => {
      const r = await getVisionAdapter(P)!.extract(Buffer.from('x'), {
        apiKey: 'k',
        mimeType: 'image/png',
        prompt: 'p',
        model: 'gpt-4o-mini',
      });
      recordStepUsage({
        model: 'gpt-4o-mini',
        input: r.tokensIn ?? 0,
        output: r.tokensOut ?? 0,
        costMicroUsd: fallbackCostMicroUsd('gpt-4o-mini', {
          input: r.tokensIn ?? 0,
          output: r.tokensOut ?? 0,
        }),
      });
    });
    expect(got).toEqual({
      trace: { tokensIn: 800, tokensOut: 150, tokensCacheRead: 0, costMicroUsd: VISION_COST },
      step: { model: 'gpt-4o-mini', tokens_in: 800, tokens_out: 150, cost_micro_usd: VISION_COST },
    });
  });

  it('vision, two pages in one step: the step meta keeps the LAST call only', async () => {
    const got = await recordPath(async () => {
      for (let page = 0; page < 2; page++) {
        const r = await getVisionAdapter(P)!.extract(Buffer.from('x'), {
          apiKey: 'k',
          mimeType: 'image/png',
          prompt: 'p',
          model: 'gpt-4o-mini',
        });
        const usage = { input: r.tokensIn ?? 0, output: r.tokensOut ?? 0 };
        recordStepUsage({
          model: 'gpt-4o-mini',
          ...usage,
          costMicroUsd: fallbackCostMicroUsd('gpt-4o-mini', usage),
        });
      }
    });
    expect(got.trace.costMicroUsd).toBe(2 * VISION_COST);
    expect(got.step.cost_micro_usd).toBe(VISION_COST);
    expect(got.step.tokens_in).toBe(800);
  });

  it('extract_from_image tool (builtins-workers): no recorder, hand tokens in the meta', async () => {
    const got = await recordPath(async (h) => {
      const r = await getVisionAdapter(P)!.extract(Buffer.from('x'), {
        apiKey: 'k',
        mimeType: 'image/png',
        prompt: 'p',
        model: 'gpt-4o-mini',
      });
      h.setMeta({ tokens_in: r.tokensIn, tokens_out: r.tokensOut });
    });
    expect(got).toEqual({
      trace: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 0 },
      step: { tokens_in: 800, tokens_out: 150 },
    });
  });

  it('summarize_text tool (builtins-workers): no recorder, hand tokens in the meta', async () => {
    const got = await recordPath(async (h) => {
      const r = await getChatAdapter(P)!.chat(chatOpts);
      h.setMeta({ tokens_in: r.tokensIn, tokens_out: r.tokensOut });
    });
    expect(got).toEqual({
      trace: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 0 },
      step: { tokens_in: 1000, tokens_out: 200 },
    });
  });

  it('research (web_search, Sonar): captureLlmUsage through the tool step sink', async () => {
    const got = await recordPath(async (h) => {
      captureLlmUsage(toolSink(h), RESEARCH_RAW, 'perplexity/sonar');
    });
    // Main skips the cache-write tokens.
    expect(got).toEqual({
      trace: { tokensIn: 400, tokensOut: 300, tokensCacheRead: 0, costMicroUsd: 6000 },
      step: {
        model: 'perplexity/sonar',
        tokens_in: 400,
        tokens_out: 300,
        cache_read: 0,
        cost_micro_usd: 6000,
      },
    });
  });

  it('run item cost (execute-item): the tool sink accumulates, a provider call does not', async () => {
    // A run item adds to its row only what a handler reports through the sink.
    let itemCost = 0;
    const itemSink = (handle: StepHandle) => ({
      ...toolSink(handle),
      addCost: (mu: number) => {
        itemCost += mu;
        handle.addCost(mu);
      },
    });
    await recordPath(async (h) => {
      captureLlmUsage(itemSink(h), RESEARCH_RAW, 'perplexity/sonar');
    });
    expect(itemCost).toBe(6000);
    // summarize_text as a run item: the chat call reaches nothing.
    itemCost = 0;
    const got = await recordPath(async (h) => {
      itemSink(h);
      await getChatAdapter(P)!.chat(chatOpts);
    });
    expect(itemCost).toBe(0);
    expect(got.trace.costMicroUsd).toBe(0);
  });

  it('embeddings (embed_batch step): nothing recorded', async () => {
    const got = await recordPath(async (h) => {
      await getEmbeddingAdapter(P)!.embed({
        apiKey: 'k',
        model: 'openai/text-embedding-3-small',
        input: ['a', 'b'],
      });
      h.setMeta({ model: 'openai/text-embedding-3-small' });
    });
    expect(got).toEqual({
      trace: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 0 },
      step: { model: 'openai/text-embedding-3-small' },
    });
  });

  it('image generation, speech, transcription: nothing recorded', async () => {
    for (const call of [
      () => getImageGenAdapter(P)!.generate({ apiKey: 'k', prompt: 'a cat', model: 'img-1' }),
      () => getTtsAdapter(P)!.synthesize({ apiKey: 'k', text: 'x'.repeat(120), model: 'tts-1' }),
      () =>
        getSttAdapter(P)!.transcribe(Buffer.from('x'), {
          apiKey: 'k',
          mimeType: 'audio/ogg',
          model: 'whisper-1',
        }),
    ]) {
      const got = await recordPath(async () => {
        await call();
      });
      expect(got).toEqual({
        trace: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 0 },
        step: {},
      });
    }
  });

  it('narration (a chat call beside a step, finishing after the trace closed): nothing', async () => {
    let late: Promise<unknown> = Promise.resolve();
    await startTrace({ ownerId: 'owner-1', kind: 'responder_turn' }, async () => {
      late = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        await getChatAdapter(P)!.chat(chatOpts);
      })();
    });
    await late;
    await flush();
    const close = h.traceUpdates.find((u) => u.status === 'success')!;
    expect(close.costMicroUsd).toBe(0);
    expect(h.traceUpdates).toHaveLength(1);
  });

  it('follow-up suggestion (after the trace closed, outside it): nothing', async () => {
    await startTrace({ ownerId: 'owner-1', kind: 'responder_turn' }, async () => {
      expect(currentTrace()).not.toBeNull();
    });
    await getChatAdapter(P)!.chat(chatOpts);
    await flush();
    expect(h.traceUpdates).toHaveLength(1);
    expect(h.traceUpdates[0]!.costMicroUsd).toBe(0);
  });
});
