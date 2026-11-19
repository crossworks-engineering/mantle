/**
 * A Telegram voice note's transcript (./voice.ts), with the STT adapter, the
 * download and the database as stand-ins:
 *  - L5: a note longer than the worker's `max_duration_seconds` is
 *    transcribed with no cap of the adapter's own, kept and used whole, and
 *    said to be long; the paid transcript is never thrown away;
 *  - the provider's "not now": a short rate limit is waited through and the
 *    same note asked again; no credit is said as such at once; any other
 *    failure is `ok: false` as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '@mantle/std';

const h = vi.hoisted(() => ({
  transcribe: vi.fn(),
  writes: [] as Record<string, unknown>[],
  worker: {
    id: 'w',
    slug: 'stt',
    provider: 'openai',
    model: 'whisper-1',
    apiKeyId: 'k',
    params: {},
  } as {
    id: string;
    slug: string;
    provider: string;
    model: string;
    apiKeyId: string;
    params: Record<string, unknown>;
  },
}));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  db: {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        h.writes.push(patch);
        return { where: async () => undefined };
      },
    }),
  },
  getDefaultWorker: async () => h.worker,
  bumpWorkerUsage: async () => undefined,
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: async () => ({ apiKey: 'test-key' }),
  resolveProviderKey: async () => null,
}));
vi.mock('@mantle/telegram', () => ({
  accountById: async () => ({ id: 'acc' }),
  downloadTelegramFile: async () => ({ bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' }),
}));
vi.mock('@mantle/voice', () => ({
  getSttAdapter: () => ({ adapterName: 'openai-stt', transcribe: h.transcribe }),
  getTtsAdapter: () => null,
  composeAudioTagInstructions: () => '',
}));
vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  step: async (_i: unknown, fn: (h: unknown) => Promise<unknown>) =>
    fn({ setMeta: () => {}, setOutput: () => {}, setSkipped: () => {}, setError: () => {} }),
}));

import { longVoiceNote, transcribeInboundVoice, voiceWaitApology } from './voice';

const row = () =>
  ({
    id: 'm1',
    accountId: 'acc',
    text: '[voice]',
    attachments: [{ kind: 'voice', file_id: 'f1' }],
  }) as never;
const sleeps: number[] = [];
const deps = {
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
};

beforeEach(() => {
  h.transcribe.mockReset();
  h.writes.length = 0;
  sleeps.length = 0;
  h.worker.params = { max_duration_seconds: 180 };
});

describe('a long voice note (L5)', () => {
  it('is transcribed with no cap of the adapter, kept, used whole, and said to be long', async () => {
    h.transcribe.mockResolvedValue({
      text: 'a ten minute note',
      language: 'en',
      durationSeconds: 600,
      model: 'whisper-1',
    });
    const r = row() as { text: string };
    const out = await transcribeInboundVoice({
      ownerId: 'o',
      row: r as never,
      voiceFileId: 'f1',
      deps,
    });
    expect(out).toEqual({ ok: true, long: true, durationSeconds: 600 });
    expect(h.transcribe.mock.calls[0]![1]).toMatchObject({ maxDurationSeconds: 0 });
    expect(r.text).toBe('a ten minute note');
    expect(h.writes[0]).toMatchObject({ text: 'a ten minute note' });
    expect(JSON.stringify(h.writes[0])).toContain('"long":true');
  });

  it('a short note is not long', async () => {
    h.transcribe.mockResolvedValue({ text: 'hi', language: 'en', durationSeconds: 4, model: 'm' });
    const out = await transcribeInboundVoice({ ownerId: 'o', row: row(), voiceFileId: 'f1', deps });
    expect(out).toEqual({ ok: true, long: false, durationSeconds: 4 });
  });

  it('the line the responder hears', () => {
    expect(longVoiceNote(372)).toBe('[A long voice note (6 min 12 s), transcribed in full.]');
    expect(longVoiceNote(null)).toContain('transcribed in full');
  });
});

describe('the provider says "not now"', () => {
  const refused = (status: number, body = '') =>
    new ProviderHttpError({ provider: 'openai', status, body });

  it('a short rate limit is waited through: the same note again, then kept', async () => {
    h.transcribe
      .mockRejectedValueOnce(refused(429))
      .mockResolvedValue({ text: 'hello', language: 'en', durationSeconds: 3, model: 'm' });
    const out = await transcribeInboundVoice({ ownerId: 'o', row: row(), voiceFileId: 'f1', deps });
    expect(out).toMatchObject({ ok: true });
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
  });

  it('no credit: at once, with its wait, and an apology that says why', async () => {
    h.transcribe.mockRejectedValue(refused(402));
    const out = await transcribeInboundVoice({ ownerId: 'o', row: row(), voiceFileId: 'f1', deps });
    expect(out).toEqual({ ok: false, wait: { reason: 'quota', status: 402 } });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(voiceWaitApology({ reason: 'quota' })).toMatch(/no credit/);
    expect(voiceWaitApology({ reason: 'overloaded' })).toMatch(/busy/);
  });

  it('any other failure is ok: false with no wait, as before', async () => {
    h.transcribe.mockRejectedValue(refused(400, 'bad audio'));
    const out = await transcribeInboundVoice({ ownerId: 'o', row: row(), voiceFileId: 'f1', deps });
    expect(out).toEqual({ ok: false });
    expect(h.writes).toEqual([]);
  });
});
