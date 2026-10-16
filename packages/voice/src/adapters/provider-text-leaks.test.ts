/**
 * A10 lows item 3: three adapters threw a plain Error carrying the
 * provider's own words (AssemblyAI's transcript error through video_ingest,
 * the OpenRouter decision endpoint's error message, a Hugging Face 2xx
 * that was no image). Each throws a ProviderHttpError now: the message is
 * unchanged (the log, the owner's trace), and a member or the model hears
 * the fixed sentence (publicProviderErrorMessage), never the words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError, publicProviderErrorMessage } from '@mantle/std';
import { assemblyAiSttAdapter } from './assemblyai-stt';
import { huggingfaceImageAdapter } from './huggingface-image';
import { openrouterDecisionAdapter } from './openrouter-decision';

const SECRET = 'org=acme-private sk-0123456789abcdef';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('provider words stay on the error (A10 lows item 3)', () => {
  it('AssemblyAI: a transcript that ends in error (the poll)', async () => {
    vi.useFakeTimers();
    const responses = [
      json({ upload_url: 'https://cdn.example/u' }),
      json({ id: 't1', status: 'queued' }),
      json({ id: 't1', status: 'error', error: `Audio could not be decoded ${SECRET}` }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );
    const p = caught(
      assemblyAiSttAdapter.transcribe(Buffer.from('x'), { apiKey: 'k', mimeType: 'audio/wav' }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await p;
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as Error).message).toBe(
      `assemblyai transcript error: Audio could not be decoded ${SECRET}`,
    );
    const text = publicProviderErrorMessage(err, 'video_ingest');
    expect(text).toBe('The provider answered without a usable result. (assemblyai)');
    expect(text).not.toContain('acme-private');
  });

  it('AssemblyAI: a transcript refused at create', async () => {
    const responses = [
      json({ upload_url: 'https://cdn.example/u' }),
      json({ id: 't1', status: 'error', error: `bad audio ${SECRET}` }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );
    const err = await caught(
      assemblyAiSttAdapter.transcribe(Buffer.from('x'), { apiKey: 'k', mimeType: 'audio/wav' }),
    );
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as Error).message).toBe(`assemblyai create-transcript: bad audio ${SECRET}`);
    expect(publicProviderErrorMessage(err, 'video_ingest')).not.toContain('acme-private');
  });

  it('OpenRouter decisions: an error answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 400, message: `bad state ${SECRET}` } }, 400)),
    );
    const err = await caught(
      openrouterDecisionAdapter.decide({
        apiKey: 'k',
        model: 'm',
        state: 's',
        questions: { q: { type: 'noul', instructions: 'yes?' } },
      }),
    );
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(400);
    expect((err as Error).message).toBe(`openrouter-decision 400: bad state ${SECRET}`);
    const text = publicProviderErrorMessage(err, 'decide');
    expect(text).toBe(
      // A10 lows fix round 1, L1: no argument named in the body, the
      // neutral sentence.
      'The model provider refused the request. (openrouter, HTTP 400)',
    );
  });

  it('Hugging Face: a 2xx that is no image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: `Model X is not deployed ${SECRET}` })),
    );
    const err = await caught(huggingfaceImageAdapter.generate({ apiKey: 'k', prompt: 'a cat' }));
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as Error).message).toContain('huggingface-image: expected image bytes');
    expect(publicProviderErrorMessage(err, 'generate_image')).toBe(
      'The provider answered without a usable result. (huggingface)',
    );
  });
});
