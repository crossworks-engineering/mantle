/**
 * Tests for the OpenRouter audio/image adapters (tts / stt / image_gen).
 * Locks the structural contract: self-registration, wired flags, and the
 * request/response shape each adapter builds against OpenRouter's API
 * (verified against their docs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTtsAdapter, getSttAdapter, getImageGenAdapter, isProviderWired } from './index';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Capture the single fetch call's URL + parsed JSON body. */
function stubFetch(response: Response): () => { url: string; body: any } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response;
    }),
  );
  return () => ({
    url: calls[0]!.url,
    body: JSON.parse(String(calls[0]!.init.body)),
  });
}

describe('openrouter-tts', () => {
  it('registers + is wired for tts', () => {
    expect(getTtsAdapter('openrouter')?.adapterName).toBe('openrouter-tts');
    expect(isProviderWired('openrouter', 'tts')).toBe(true);
  });

  it('hits /audio/speech, clamps opus→mp3, returns bytes + mime', async () => {
    const read = stubFetch(new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }));
    const out = await getTtsAdapter('openrouter')!.synthesize({
      apiKey: 'k',
      text: 'hello there',
      format: 'opus', // unsupported by OR → must clamp to mp3
    });
    const { url, body } = read();
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(body.response_format).toBe('mp3');
    // OpenRouter has no OpenAI TTS — default to a real speech route on it.
    expect(body.model).toBe('x-ai/grok-voice-tts-1.0');
    expect(body.voice).toBe('ara'); // default grok voice (passed through verbatim)
    expect(out.mimeType).toBe('audio/mpeg');
    expect(out.bytes.length).toBe(3);
  });
});

describe('openrouter-stt', () => {
  it('registers + is wired for stt', () => {
    expect(getSttAdapter('openrouter')?.adapterName).toBe('openrouter-stt');
    expect(isProviderWired('openrouter', 'stt')).toBe(true);
  });

  it('sends base64 input_audio + format from mime, parses {text}', async () => {
    const read = stubFetch(
      new Response(JSON.stringify({ text: '  hi there  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await getSttAdapter('openrouter')!.transcribe(Buffer.from('audiobytes'), {
      apiKey: 'k',
      mimeType: 'audio/ogg',
      language: 'en',
    });
    const { url, body } = read();
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(body.input_audio.format).toBe('ogg');
    expect(body.input_audio.data).toBe(Buffer.from('audiobytes').toString('base64'));
    expect(body.model).toBe('openai/gpt-4o-mini-transcribe');
    expect(out.text).toBe('hi there');
  });
});

describe('openrouter-image', () => {
  it('registers + is wired for image_gen + has a static catalog', () => {
    const a = getImageGenAdapter('openrouter');
    expect(a?.adapterName).toBe('openrouter-image');
    expect(isProviderWired('openrouter', 'image_gen')).toBe(true);
    expect(a!.staticCatalog().length).toBeGreaterThan(0);
  });

  it('uses chat/completions+modalities, decodes the data-URL image', async () => {
    const pngB64 = Buffer.from('fakepng').toString('base64');
    const read = stubFetch(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'here you go',
                images: [{ image_url: { url: `data:image/png;base64,${pngB64}` } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const out = await getImageGenAdapter('openrouter')!.generate({ apiKey: 'k', prompt: 'a cat' });
    const { url, body } = read();
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body.modalities).toEqual(['image', 'text']);
    expect(out.mimeType).toBe('image/png');
    expect(out.bytes.toString()).toBe('fakepng');
    expect(out.revisedPrompt).toBe('here you go');
  });
});
