import { describe, expect, it } from 'vitest';
import { voiceCatalogSupplement } from './builtins-curation';

describe('voiceCatalogSupplement', () => {
  const sup = voiceCatalogSupplement();

  it('covers the wired voice engines OpenRouter omits', () => {
    const ids = sup.map((m) => `${m.provider}:${m.id}`);
    expect(ids).toContain('xai:grok-voice-latest');
    expect(ids).toContain('openrouter:x-ai/grok-voice-tts-1.0');
    expect(ids).toContain('openai:whisper-1');
    expect(sup.some((m) => m.provider === 'elevenlabs' && m.kind === 'tts')).toBe(true);
    expect(sup.some((m) => m.provider === 'deepgram' && m.kind === 'stt')).toBe(true);
  });

  it('every row is audio-kinded with honest (null) pricing and unique per provider+id', () => {
    const seen = new Set<string>();
    for (const m of sup) {
      expect(m.kind === 'tts' || m.kind === 'stt').toBe(true);
      expect(m.inputPerM).toBeNull();
      expect(m.outputPerM).toBeNull();
      const key = `${m.provider}:${m.id}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
