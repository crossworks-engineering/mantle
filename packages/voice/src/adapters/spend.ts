/**
 * The recording point (A10 #5, docs/spend-recording.md): every adapter the
 * registry hands out is wrapped here, per capability, so each provider call
 * that returns writes its usage through the one recorder (@mantle/tracing
 * recordUsage). Callers record nothing by hand; which trace and step the
 * usage lands on comes from context.
 *
 * A call that throws records nothing (no usage came back). The chat wrapper
 * sits OUTSIDE the retry wrapper, so a call retried three times is one
 * recording: the attempt that answered.
 *
 * Recording never costs a call its result: every recording, from reading the
 * result and the options to the recorder itself, runs inside `record`, which
 * swallows and logs any throw. A paid result is always returned, so a broken
 * recording can never turn into a retry that pays again (A10 #5 fix round 1).
 */
import { errorMessage } from '@mantle/std';
import { recordUsage, type ProviderUsage } from '@mantle/tracing';
import type {
  ChatDispatcher,
  ChatOptions,
  ChatResult,
  ChatStreamSink,
  DecisionDispatcher,
  EmbeddingDispatcher,
  ImageGenDispatcher,
  SttDispatcher,
  TtsDispatcher,
  VisionDispatcher,
  VisionExtractOptions,
  VisionExtractResult,
} from './types';

/** Record one call's usage, built by `build` after the call returned. Never
 *  throws: a throw while building or recording is logged and dropped. */
export function record(build: () => ProviderUsage): void {
  try {
    recordUsage(build());
  } catch (err) {
    console.error(`[voice] record spend: ${errorMessage(err)}`);
  }
}

function recordChat(provider: string, opts: ChatOptions, r: ChatResult): void {
  record(() => ({
    capability: 'chat',
    provider,
    model: r.model || opts.model,
    priceAs: [opts.model, r.model],
    inputTokens: r.tokensIn ?? 0,
    outputTokens: r.tokensOut ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    ...(r.cacheWriteTokens ? { cacheWriteTokens: r.cacheWriteTokens } : {}),
    ...(r.reportedCostUsd !== undefined ? { reportedCostUsd: r.reportedCostUsd } : {}),
  }));
}

/** One vision call's usage. Exported for ./vision-images.ts, whose
 *  several-image call is not on a dispatcher. */
export function recordVision(
  provider: string,
  opts: VisionExtractOptions,
  r: VisionExtractResult,
): void {
  record(() => ({
    capability: 'vision',
    provider,
    // The configured id, as the vision workers always recorded it.
    model: opts.model || r.model,
    priceAs: [opts.model, r.model],
    inputTokens: r.tokensIn ?? 0,
    outputTokens: r.tokensOut ?? 0,
  }));
}

const wrapped = new WeakMap<object, object>();

function once<T extends object>(adapter: T, wrap: (a: T) => T): T {
  const hit = wrapped.get(adapter);
  if (hit) return hit as T;
  const made = wrap(adapter);
  wrapped.set(adapter, made);
  return made;
}

export function recordingChat(adapter: ChatDispatcher): ChatDispatcher {
  return once(adapter, (a) => {
    const chat = async (opts: ChatOptions): Promise<ChatResult> => {
      const r = await a.chat(opts);
      recordChat(a.providerId, opts, r);
      return r;
    };
    const inner = a.chatStream?.bind(a);
    const chatStream = inner
      ? async (opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> => {
          const r = await inner(opts, onDelta);
          recordChat(a.providerId, opts, r);
          return r;
        }
      : undefined;
    return { ...a, chat, ...(chatStream ? { chatStream } : {}) };
  });
}

export function recordingDecision(adapter: DecisionDispatcher): DecisionDispatcher {
  return once(adapter, (a) => ({
    ...a,
    decide: async (opts) => {
      const r = await a.decide(opts);
      record(() => ({
        capability: 'decision',
        provider: a.providerId,
        model: r.model || opts.model,
        priceAs: [opts.model, r.model],
        inputTokens: r.tokensIn ?? 0,
        outputTokens: r.tokensOut ?? 0,
        cacheReadTokens: 0,
        ...(r.reportedCostUsd !== undefined ? { reportedCostUsd: r.reportedCostUsd } : {}),
      }));
      return r;
    },
  }));
}

export function recordingEmbedding(adapter: EmbeddingDispatcher): EmbeddingDispatcher {
  return once(adapter, (a) => ({
    ...a,
    embed: async (req) => {
      const r = await a.embed(req);
      record(() => ({
        capability: 'embedding',
        provider: a.providerId,
        model: req.model,
        priceAs: [req.model, r.model],
        inputTokens: r.tokensIn ?? 0,
        outputTokens: 0,
      }));
      return r;
    },
  }));
}

export function recordingVision(adapter: VisionDispatcher): VisionDispatcher {
  return once(adapter, (a) => {
    const extractDocument = a.extractDocument?.bind(a);
    return {
      ...a,
      extract: async (image, opts) => {
        const r = await a.extract(image, opts);
        recordVision(a.providerId, opts, r);
        return r;
      },
      ...(extractDocument
        ? {
            extractDocument: async (doc: Buffer, opts: VisionExtractOptions) => {
              const r = await extractDocument(doc, opts);
              recordVision(a.providerId, opts, r);
              return r;
            },
          }
        : {}),
    };
  });
}

export function recordingImageGen(adapter: ImageGenDispatcher): ImageGenDispatcher {
  return once(adapter, (a) => ({
    ...a,
    generate: async (opts) => {
      const r = await a.generate(opts);
      record(() => ({
        capability: 'image_gen',
        provider: a.providerId,
        model: r.model || opts.model || '',
        units: { kind: 'images', count: 1 },
      }));
      return r;
    },
  }));
}

export function recordingTts(adapter: TtsDispatcher): TtsDispatcher {
  return once(adapter, (a) => ({
    ...a,
    synthesize: async (opts) => {
      const r = await a.synthesize(opts);
      record(() => ({
        capability: 'tts',
        provider: a.providerId,
        model: r.model || opts.model || '',
        units: { kind: 'characters', count: opts.text.length },
      }));
      return r;
    },
  }));
}

export function recordingStt(adapter: SttDispatcher): SttDispatcher {
  return once(adapter, (a) => ({
    ...a,
    transcribe: async (audio, opts) => {
      const r = await a.transcribe(audio, opts);
      record(() => ({
        capability: 'stt',
        provider: a.providerId,
        model: r.model || opts.model || '',
        ...(typeof r.durationSeconds === 'number'
          ? { units: { kind: 'audio_seconds' as const, count: r.durationSeconds } }
          : {}),
      }));
      return r;
    },
  }));
}
