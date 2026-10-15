/**
 * The recording point never costs a call its result (A10 #5 fix round 1): a
 * throw while a recording is built (reading the options or the result) or
 * written (the recorder) is logged and dropped, the paid result is returned,
 * and the provider is called once (no retry that pays again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ throwing: false, recorded: [] as unknown[] }));

vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  recordUsage: (u: unknown) => {
    if (h.throwing) throw new Error('recorder down');
    h.recorded.push(u);
    return 0;
  },
}));

import {
  recordingChat,
  recordingDecision,
  recordingEmbedding,
  recordingImageGen,
  recordingStt,
  recordingTts,
  recordingVision,
} from './spend';
import type {
  ChatDispatcher,
  DecisionDispatcher,
  EmbeddingDispatcher,
  ImageGenDispatcher,
  SttDispatcher,
  TtsDispatcher,
  VisionDispatcher,
} from './types';

const P = 'spend-test' as never;
let calls = 0;
const counted = <T>(v: T) => {
  calls++;
  return v;
};

/** A result whose `model` throws on read, as a broken provider shape would. */
function poisoned<T extends object>(r: T): T {
  return Object.defineProperty({ ...r }, 'model', {
    get() {
      throw new Error('bad result shape');
    },
  }) as T;
}

const chat: ChatDispatcher = {
  providerId: P,
  adapterName: 'c',
  chat: async () => counted(poisoned({ text: 'paid', model: 'm', tokensIn: 1, tokensOut: 1 })),
  chatStream: async () =>
    counted(poisoned({ text: 'paid', model: 'm', tokensIn: 1, tokensOut: 1 })),
};
const decision: DecisionDispatcher = {
  providerId: P,
  adapterName: 'd',
  decide: async () => counted(poisoned({ answers: {}, model: 'm', tokensIn: 1, tokensOut: 0 })),
};
const embedding: EmbeddingDispatcher = {
  providerId: P,
  adapterName: 'e',
  embed: async () => counted(poisoned({ vectors: [[1]], model: 'm', tokensIn: 1 })),
};
const vision: VisionDispatcher = {
  providerId: P,
  adapterName: 'v',
  extract: async () => counted(poisoned({ text: 'paid', model: 'm' })),
  extractDocument: async () => counted(poisoned({ text: 'paid', model: 'm' })),
};
const image: ImageGenDispatcher = {
  providerId: P,
  adapterName: 'i',
  supports: [],
  generate: async () =>
    counted(poisoned({ bytes: Buffer.from('png'), mimeType: 'image/png', model: 'm' })),
  staticCatalog: () => [],
};
const tts: TtsDispatcher = {
  providerId: P,
  adapterName: 't',
  supports: [],
  synthesize: async () =>
    counted({ bytes: Buffer.from('ogg'), mimeType: 'audio/ogg', voice: 'nova', model: 'm' }),
};
const stt: SttDispatcher = {
  providerId: P,
  adapterName: 's',
  supports: [],
  transcribe: async () =>
    counted(poisoned({ text: 'paid', language: 'en', durationSeconds: 3, model: 'm' })),
};

/** Every wrapped call, with options that are themselves broken where they
 *  are read (speech with no text). */
const paths: Array<[string, () => Promise<unknown>]> = [
  ['chat', () => recordingChat(chat).chat({ apiKey: 'k', model: 'm', messages: [] })],
  [
    'chatStream',
    () => recordingChat(chat).chatStream!({ apiKey: 'k', model: 'm', messages: [] }, () => {}),
  ],
  [
    'decide',
    () => recordingDecision(decision).decide({ apiKey: 'k', model: 'm', state: {}, questions: {} }),
  ],
  ['embed', () => recordingEmbedding(embedding).embed({ apiKey: 'k', model: 'm', input: ['a'] })],
  [
    'extract',
    () =>
      recordingVision(vision).extract(Buffer.from('x'), {
        apiKey: 'k',
        mimeType: 'image/png',
        prompt: 'p',
      }),
  ],
  [
    'extractDocument',
    () =>
      recordingVision(vision).extractDocument!(Buffer.from('x'), {
        apiKey: 'k',
        mimeType: 'application/pdf',
        prompt: 'p',
      }),
  ],
  ['generate', () => recordingImageGen(image).generate({ apiKey: 'k', prompt: 'p' })],
  [
    'synthesize',
    () => recordingTts(tts).synthesize({ apiKey: 'k', text: undefined as unknown as string }),
  ],
  [
    'transcribe',
    () => recordingStt(stt).transcribe(Buffer.from('x'), { apiKey: 'k', mimeType: 'audio/ogg' }),
  ],
];

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls = 0;
  h.recorded.length = 0;
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  h.throwing = false;
  errors.mockRestore();
});

describe('a recording that throws never costs the call its result', () => {
  for (const [name, call] of paths) {
    it(`${name}: a broken result or options shape`, async () => {
      const r = await call();
      expect(r).toBeDefined();
      expect(calls).toBe(1);
      expect(h.recorded).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('[voice] record spend'));
    });

    it(`${name}: a recorder that throws`, async () => {
      h.throwing = true;
      await expect(call()).resolves.toBeDefined();
      expect(calls).toBe(1);
    });
  }
});
