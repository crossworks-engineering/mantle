/**
 * The TTS parameter surface, checked against each provider's own docs
 * (2026-08). Two mechanisms, same purpose as the image side: an option an
 * operator saves in /settings/ai-workers must never LOOK like it applied.
 *
 *   · `supports` is the per-PROVIDER truth, used by the caller to report.
 *   · `warnings` is the per-MODEL truth, which only the adapter knows.
 *
 * The declarations are pinned here because they are claims about someone
 * else's API: if a provider ships a knob we already claimed to lack, the
 * fix belongs in the adapter and this test is where the old belief dies.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTtsAdapter } from './index';

describe('TTS supports declarations', () => {
  it('openai: speed + format + instructions, and NO language', () => {
    // /v1/audio/speech has no language field; the model infers from text.
    expect([...getTtsAdapter('openai')!.supports].sort()).toEqual([
      'format',
      'instructions',
      'speed',
    ]);
  });

  it('xai: speed EXISTS, plus format and language', () => {
    // Regression: the adapter used to assert "the speed knob doesn't exist
    // on Grok TTS" and never sent it. docs.x.ai documents 0.7-1.5.
    const s = getTtsAdapter('xai')!.supports;
    expect(s).toContain('speed');
    expect(s).toContain('language');
    expect(s).not.toContain('instructions');
  });

  it('google: format only — Gemini TTS has no speed or style parameter', () => {
    expect([...getTtsAdapter('google')!.supports]).toEqual(['format']);
  });

  it('elevenlabs: speed (in voice_settings), format, language_code', () => {
    expect([...getTtsAdapter('elevenlabs')!.supports].sort()).toEqual([
      'format',
      'language',
      'speed',
    ]);
  });
});

describe('xai-tts speed', () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(Buffer.from('audio'), { status: 200 });
    });
    return () => body;
  };

  it('forwards a speed inside the documented band', async () => {
    const read = capture();
    await getTtsAdapter('xai')!.synthesize({ apiKey: 'k', text: 'hi', speed: 1.2 });
    expect(read().speed).toBe(1.2);
  });

  it('clamps out-of-band speed and says so rather than pretending', async () => {
    const read = capture();
    const out = await getTtsAdapter('xai')!.synthesize({ apiKey: 'k', text: 'hi', speed: 3 });
    expect(read().speed).toBe(1.5);
    expect(out.warnings?.[0]).toMatchObject({ param: 'speed' });
    expect(out.warnings?.[0]!.reason).toContain('1.5');
  });

  it('omits speed entirely at the default, keeping the body minimal', async () => {
    const read = capture();
    await getTtsAdapter('xai')!.synthesize({ apiKey: 'k', text: 'hi', speed: 1.0 });
    expect(read()).not.toHaveProperty('speed');
  });
});

describe('elevenlabs-tts language_code', () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(Buffer.from('audio'), { status: 200 });
    });
    return () => body;
  };

  it('forwards language_code on a model that accepts it', async () => {
    const read = capture();
    await getTtsAdapter('elevenlabs')!.synthesize({
      apiKey: 'k',
      text: 'hi',
      model: 'eleven_v3',
      language: 'fr',
    });
    expect(read().language_code).toBe('fr');
  });

  it('warns instead of sending on multilingual_v2, which rejects the idea', async () => {
    const read = capture();
    const out = await getTtsAdapter('elevenlabs')!.synthesize({
      apiKey: 'k',
      text: 'hi',
      model: 'eleven_multilingual_v2',
      language: 'fr',
    });
    expect(read()).not.toHaveProperty('language_code');
    expect(out.warnings?.[0]).toMatchObject({ param: 'language' });
  });

  it("treats 'auto' as no request at all", async () => {
    const read = capture();
    const out = await getTtsAdapter('elevenlabs')!.synthesize({
      apiKey: 'k',
      text: 'hi',
      model: 'eleven_v3',
      language: 'auto',
    });
    expect(read()).not.toHaveProperty('language_code');
    expect(out.warnings).toBeUndefined();
  });
});
