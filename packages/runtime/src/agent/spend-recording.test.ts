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
 * The first commit of this file recorded MAIN (three recorders, three hand
 * cost sinks, paths that recorded nothing). Since the move every adapter the
 * registry hands out records its own call (packages/voice/src/adapters/
 * spend.ts), so no call site records by hand. Every cell is the same as main
 * except the ones marked NAMED, each with its main value
 * (docs/spend-recording.md "Named changes"). One cell changes everywhere: the
 * step meta now names the call's `provider`.
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
  chargeTo,
  currentTrace,
  spendTarget,
  startTrace,
  step,
  type SpendTarget,
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
/** A provider that answers under a dated id the price table lacks. */
const DATED = 'spend-fake-dated' as never;
const fakeDatedChat: ChatDispatcher = {
  providerId: DATED,
  adapterName: 'spend-fake-dated-chat',
  chat: async () => ({ text: 'ok', ...CHAT, model: 'anthropic/dated-x' }),
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
  registerChatAdapter(fakeDatedChat);
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
  'provider',
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

/** A call's full chat meta, as the recorder writes it. */
const CHAT_META = {
  model: CHAT.model,
  provider: P,
  tokens_in: 1000,
  tokens_out: 200,
  cache_read: 300,
  cache_write: 100,
  cost_micro_usd: CHAT_COST,
};
const CHAT_TRACE = {
  tokensIn: 1100,
  tokensOut: 200,
  tokensCacheRead: 300,
  costMicroUsd: CHAT_COST,
};
const NOTHING = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 0 };

const visionOpts = { apiKey: 'k', mimeType: 'image/png', prompt: 'p', model: 'gpt-4o-mini' };

// ─── The paths ───────────────────────────────────────────────────────────────

describe('spend recording per call path', () => {
  it('tool loop chat round (model-caller)', async () => {
    const got = await recordPath(() => getChatAdapter(P)!.chat(chatOpts));
    // provider: NAMED (absent on main).
    expect(got).toEqual({ trace: CHAT_TRACE, step: CHAT_META });
  });

  it('tool loop streamed round', async () => {
    const got = await recordPath(() => getChatAdapter(P)!.chatStream!(chatOpts, () => {}));
    expect(got).toEqual({ trace: CHAT_TRACE, step: CHAT_META });
  });

  it('worker chat (summarizer, reflector, archive, extractor)', async () => {
    // Requested an id the table lacks, served a priced one: priced on the
    // served id, as main.
    const got = await recordPath(() => getChatAdapter(P)!.chat({ ...chatOpts, model: '' }));
    expect(got.trace.costMicroUsd).toBe(CHAT_COST);
    // Requested a priced id, served under an unpriced dated one.
    const got2 = await recordPath(() => getChatAdapter(DATED)!.chat(chatOpts));
    // NAMED: main priced the worker paths on the served id only: 0.
    expect(got2.trace.costMicroUsd).toBe(CHAT_COST);
  });

  it('decider (decide.ts)', async () => {
    const got = await recordPath(() =>
      getDecisionAdapter(P)!.decide({
        apiKey: 'k',
        model: 'typesafe/jev-1.13',
        state: {},
        questions: { q: { type: 'noul', instructions: 'x' } },
      }),
    );
    expect(got).toEqual({
      trace: { tokensIn: 500, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 21 },
      step: {
        model: 'typesafe/jev-1.13',
        provider: P,
        tokens_in: 500,
        tokens_out: 0,
        cache_read: 0,
        cost_micro_usd: 21,
      },
    });
  });

  it('vision worker (attachments runVisionWorker, runDocumentWorker)', async () => {
    const got = await recordPath(() => getVisionAdapter(P)!.extract(Buffer.from('x'), visionOpts));
    const doc = await recordPath(() =>
      getVisionAdapter(P)!.extractDocument!(Buffer.from('x'), visionOpts),
    );
    const want = {
      trace: { tokensIn: 800, tokensOut: 150, tokensCacheRead: 0, costMicroUsd: VISION_COST },
      step: {
        model: 'gpt-4o-mini',
        provider: P,
        tokens_in: 800,
        tokens_out: 150,
        cost_micro_usd: VISION_COST,
      },
    };
    expect(got).toEqual(want);
    expect(doc).toEqual(want);
  });

  it('vision, two pages in one step: the step meta sums the calls', async () => {
    const got = await recordPath(async () => {
      for (let page = 0; page < 2; page++) {
        await getVisionAdapter(P)!.extract(Buffer.from('x'), visionOpts);
      }
    });
    expect(got.trace.costMicroUsd).toBe(2 * VISION_COST);
    // NAMED: main kept the last call's (210, 800).
    expect(got.step.cost_micro_usd).toBe(2 * VISION_COST);
    expect(got.step.tokens_in).toBe(1600);
  });

  it('extract_from_image tool (builtins-workers)', async () => {
    const got = await recordPath(() => getVisionAdapter(P)!.extract(Buffer.from('x'), visionOpts));
    // NAMED: main recorded nothing on the trace (0, 0, 0, 0) and only the
    // hand tokens_in / tokens_out on the step.
    expect(got.trace).toEqual({
      tokensIn: 800,
      tokensOut: 150,
      tokensCacheRead: 0,
      costMicroUsd: VISION_COST,
    });
    expect(got.step.cost_micro_usd).toBe(VISION_COST);
  });

  it('summarize_text tool (builtins-workers)', async () => {
    const got = await recordPath(() => getChatAdapter(P)!.chat(chatOpts));
    // NAMED: main recorded nothing on the trace and only the hand tokens on
    // the step.
    expect(got).toEqual({ trace: CHAT_TRACE, step: CHAT_META });
  });

  it('research (web_search, Sonar): the raw-response reader', async () => {
    const got = await recordPath(async () => {
      captureLlmUsage(RESEARCH_RAW, 'perplexity/sonar');
    });
    expect(got).toEqual({
      // NAMED: tokensIn 400 on main (the cache-write tokens were skipped).
      trace: { tokensIn: 450, tokensOut: 300, tokensCacheRead: 0, costMicroUsd: 6000 },
      step: {
        model: 'perplexity/sonar',
        provider: 'openrouter',
        tokens_in: 400,
        tokens_out: 300,
        cache_read: 0,
        // NAMED: absent on main.
        cache_write: 50,
        cost_micro_usd: 6000,
      },
    });
  });

  it('run item cost (execute-item): the item trace totals', async () => {
    // execute-item reads its own trace's totals once the tool returns.
    const itemCost = async (tool: () => Promise<unknown>) => {
      let trace = null as ReturnType<typeof currentTrace>;
      await startTrace({ ownerId: 'owner-1', kind: 'run_item' }, async () => {
        trace = currentTrace();
        return step({ name: 'tool: x', kind: 'compute' }, tool);
      });
      return trace?.costMicroUsd ?? 0;
    };
    expect(await itemCost(async () => captureLlmUsage(RESEARCH_RAW, 'perplexity/sonar'))).toBe(
      6000,
    );
    // NAMED: 0 on main (a provider call inside a run item's tool reached
    // neither the trace nor the item row).
    expect(await itemCost(() => getChatAdapter(P)!.chat(chatOpts))).toBe(CHAT_COST);
  });

  it('embeddings (embed_batch step)', async () => {
    const got = await recordPath(async (h) => {
      await getEmbeddingAdapter(P)!.embed({
        apiKey: 'k',
        model: 'openai/text-embedding-3-small',
        input: ['a', 'b'],
      });
      h.setMeta({ model: 'openai/text-embedding-3-small', provider: P });
    });
    // NAMED: main recorded nothing (trace 0, step { model }).
    expect(got).toEqual({
      trace: { tokensIn: 50, tokensOut: 0, tokensCacheRead: 0, costMicroUsd: 1 },
      step: {
        model: 'openai/text-embedding-3-small',
        provider: P,
        tokens_in: 50,
        tokens_out: 0,
        cost_micro_usd: 1,
      },
    });
  });

  it('image generation, speech, transcription: units, no price', async () => {
    const cases: Array<[() => Promise<unknown>, Record<string, unknown>]> = [
      [
        () => getImageGenAdapter(P)!.generate({ apiKey: 'k', prompt: 'a cat', model: 'img-1' }),
        { model: 'img-1', images: 1 },
      ],
      [
        () => getTtsAdapter(P)!.synthesize({ apiKey: 'k', text: 'x'.repeat(120), model: 'tts-1' }),
        { model: 'tts-1', characters: 120 },
      ],
      [
        () =>
          getSttAdapter(P)!.transcribe(Buffer.from('x'), {
            apiKey: 'k',
            mimeType: 'audio/ogg',
            model: 'whisper-1',
          }),
        { model: 'whisper-1', audio_seconds: 42 },
      ],
    ];
    for (const [call, units] of cases) {
      const got = await recordPath(call);
      // NAMED: main recorded nothing (step {}). The trace stays at 0: these
      // calls carry no tokens and the price table has no unit prices.
      expect(got).toEqual({
        trace: NOTHING,
        step: { ...units, provider: P, cost_micro_usd: 0 },
      });
    }
  });

  it('narration: charged to the turn, landing after the trace closed', async () => {
    let late: Promise<unknown> = Promise.resolve();
    h.traceUpdates.length = 0;
    await startTrace({ ownerId: 'owner-1', kind: 'responder_turn' }, () =>
      step({ name: 'tool: x', kind: 'compute' }, async () => {
        // As narrateStatus: kicked off beside the step, not awaited by it.
        late = chargeTo(spendTarget(), async () => {
          await new Promise((r) => setTimeout(r, 5));
          return getChatAdapter(P)!.chat(chatOpts);
        });
      }),
    );
    await late;
    await flush();
    const [close, increment] = h.traceUpdates;
    expect(close).toMatchObject({ status: 'success', costMicroUsd: 0 });
    // NAMED: main wrote nothing more. Now one increment of the call's usage.
    expect(increment).toBeDefined();
    expect(h.stepUpdates.at(-1)!.meta).toEqual({});
  });

  it('follow-up suggestion: charged to the turn after it closed', async () => {
    let target: SpendTarget | null = null;
    h.traceUpdates.length = 0;
    await startTrace({ ownerId: 'owner-1', kind: 'responder_turn' }, async () => {
      target = spendTarget();
    });
    await chargeTo(target, () => getChatAdapter(P)!.chat(chatOpts));
    await flush();
    // NAMED: main wrote the close only.
    expect(h.traceUpdates).toHaveLength(2);
  });

  it('a call outside any trace records nowhere, as on main', async () => {
    h.traceUpdates.length = 0;
    await getChatAdapter(P)!.chat(chatOpts);
    await flush();
    expect(h.traceUpdates).toHaveLength(0);
  });
});
