/**
 * STT adapters, checked against each provider's own docs (2026-08).
 *
 * Transcription's normalized surface is thin — a language hint and nothing
 * else — so `supports` carries little information here, and that is itself
 * worth pinning: the interesting divergence is in what each provider REPORTS
 * BACK, not what it accepts.
 *
 * The regressions below are both xAI, and both the same shape as the TTS ones:
 * a comment asserting something about someone else's API that had stopped
 * being true.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSttAdapter, listSttAdapters } from './index';

describe('STT supports declarations', () => {
  it('every wired adapter forwards the language hint', () => {
    for (const a of listSttAdapters()) {
      expect([...a.supports], a.adapterName).toEqual(['language']);
    }
  });
});

describe('xai-stt', () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = (body: Record<string, unknown>) => {
    let form: FormData | null = null;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return () => form!;
  };

  // `format=true` requires `language` per docs.x.ai. It used to be sent
  // unconditionally, so the common auto-detect path carried a flag the
  // request could not satisfy.
  it('omits the format flag when no language is set', async () => {
    const read = capture({ text: 'hello' });
    await getSttAdapter('xai')!.transcribe(Buffer.from('audio'), {
      apiKey: 'k',
      mimeType: 'audio/ogg',
    });
    expect(read().get('format')).toBeNull();
    expect(read().get('language')).toBeNull();
  });

  it('enables formatting only alongside a language', async () => {
    const read = capture({ text: 'hello' });
    await getSttAdapter('xai')!.transcribe(Buffer.from('audio'), {
      apiKey: 'k',
      mimeType: 'audio/ogg',
      language: 'en',
    });
    expect(read().get('language')).toBe('en');
    expect(read().get('format')).toBe('true');
  });

  // The response carries {text, language, duration}. Both of the latter used
  // to be discarded, with a comment claiming they weren't returned at all.
  it('reads back the detected language and duration', async () => {
    capture({ text: 'hallo', language: 'af', duration: 4.2 });
    const out = await getSttAdapter('xai')!.transcribe(Buffer.from('audio'), {
      apiKey: 'k',
      mimeType: 'audio/ogg',
    });
    expect(out.language).toBe('af');
    expect(out.durationSeconds).toBe(4.2);
  });

  it('enforces the duration cap now that duration actually arrives', async () => {
    capture({ text: 'long', duration: 600 });
    await expect(
      getSttAdapter('xai')!.transcribe(Buffer.from('audio'), {
        apiKey: 'k',
        mimeType: 'audio/ogg',
        maxDurationSeconds: 180,
      }),
    ).rejects.toThrow(/exceeds 180s/);
  });
});
