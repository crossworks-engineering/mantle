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

  /** A `/api/v1/images` success body. */
  const imagesResponse = (b64: string, mediaType = 'image/png') =>
    new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64, media_type: mediaType }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('uses the dedicated /images endpoint and decodes b64_json', async () => {
    const pngB64 = Buffer.from('fakepng').toString('base64');
    const read = stubFetch(imagesResponse(pngB64));
    const out = await getImageGenAdapter('openrouter')!.generate({ apiKey: 'k', prompt: 'a cat' });
    const { url, body } = read();
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(body.prompt).toBe('a cat');
    expect(out.mimeType).toBe('image/png');
    expect(out.bytes.toString()).toBe('fakepng');
  });

  // The regression this file now guards: the chat-completions path took a
  // model and a prompt only, so an operator's saved size/quality never left
  // the process and no trace said so.
  it('forwards the sizing controls it declares support for', async () => {
    const read = stubFetch(imagesResponse(Buffer.from('x').toString('base64')));
    await getImageGenAdapter('openrouter')!.generate({
      apiKey: 'k',
      prompt: 'a cat',
      size: '2K',
      aspectRatio: '16:9',
      quality: 'high',
      seed: 7,
    });
    const { body } = read();
    expect(body).toMatchObject({ size: '2K', aspect_ratio: '16:9', quality: 'high', seed: 7 });
  });

  // Explicit pixels are authoritative upstream; pairing them with a ratio is
  // a 400, so exactly one sizing key goes on the wire.
  it('drops aspect_ratio when size is explicit pixels', async () => {
    const read = stubFetch(imagesResponse(Buffer.from('x').toString('base64')));
    await getImageGenAdapter('openrouter')!.generate({
      apiKey: 'k',
      prompt: 'a cat',
      size: '2048x2048',
      aspectRatio: '16:9',
    });
    const { body } = read();
    expect(body.size).toBe('2048x2048');
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('declares what it forwards, so the caller can report the rest', () => {
    const a = getImageGenAdapter('openrouter')!;
    expect([...a.supports].sort()).toEqual([
      'aspectRatio',
      'inputImages',
      'quality',
      'seed',
      'size',
    ]);
    expect(a.supports).not.toContain('style');
  });
});

/**
 * Image-to-image. Without it, "make the sky orange in that one" can only be
 * served by generating a DIFFERENT picture from a rewritten prompt.
 */
describe('openrouter-image editing', () => {
  const okResponse = () =>
    new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('sends references as data URLs under input_references', async () => {
    const read = stubFetch(okResponse());
    await getImageGenAdapter('openrouter')!.generate({
      apiKey: 'k',
      prompt: 'make the sky orange',
      inputImages: [{ bytes: Buffer.from('img'), mimeType: 'image/jpeg' }],
    });
    const { body } = read();
    // Objects, not bare strings — a data-URL string is a 400 from OpenRouter
    // ("expected object, received string"), which is how the first version
    // shipped and how a live probe found it.
    expect(body.input_references).toEqual([
      {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${Buffer.from('img').toString('base64')}` },
      },
    ]);
  });

  it('omits input_references entirely for a fresh generation', async () => {
    const read = stubFetch(okResponse());
    await getImageGenAdapter('openrouter')!.generate({ apiKey: 'k', prompt: 'a cat' });
    expect(read().body).not.toHaveProperty('input_references');
  });

  it('declares the capability, so the caller can refuse before spending', () => {
    expect(getImageGenAdapter('openrouter')!.supports).toContain('inputImages');
    expect(getImageGenAdapter('xai')!.supports).not.toContain('inputImages');
  });
});

/**
 * Sizing precedence, found by a live probe: the request said "16:9", the trace
 * claimed 16:9 applied, and the file came back 1024x1024. The worker's DEFAULT
 * pixel size outranked the user's explicit ratio, and the drop was silent.
 * The caller resolves provenance now; this is the adapter-side backstop.
 */
describe('openrouter-image sizing conflict', () => {
  const okResponse = () =>
    new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('warns when an explicit pixel size forces the ratio to be dropped', async () => {
    const read = stubFetch(okResponse());
    const out = await getImageGenAdapter('openrouter')!.generate({
      apiKey: 'k',
      prompt: 'a lighthouse',
      size: '1024x1024',
      aspectRatio: '16:9',
    });
    expect(read().body).not.toHaveProperty('aspect_ratio');
    expect(out.warnings?.[0]).toMatchObject({ param: 'aspectRatio' });
    expect(out.warnings?.[0]!.reason).toContain('1024x1024');
  });

  it('says nothing when a TIER size and a ratio coexist happily', async () => {
    const read = stubFetch(okResponse());
    const out = await getImageGenAdapter('openrouter')!.generate({
      apiKey: 'k',
      prompt: 'a lighthouse',
      size: '2K',
      aspectRatio: '16:9',
    });
    expect(read().body).toMatchObject({ size: '2K', aspect_ratio: '16:9' });
    expect(out.warnings).toBeUndefined();
  });
});
