import { describe, it, expect } from 'vitest';
import { resolveWorkerRoute } from './worker-route';
import { MANIFEST_WORKERS, DEFAULT_WORKER_MODEL, type ManifestWorker } from './manifest';

const tts = MANIFEST_WORKERS.find((w) => w.kind === 'tts')!;
const extractor = MANIFEST_WORKERS.find((w) => w.kind === 'extractor')!;

describe('resolveWorkerRoute', () => {
  it('uses the default route on the OpenRouter-only baseline', () => {
    const r = resolveWorkerRoute(tts, new Set(['openrouter']));
    expect(r).toMatchObject({
      provider: 'openrouter',
      model: 'x-ai/grok-voice-tts-1.0',
      keyService: 'openrouter',
    });
  });

  it('upgrades voice to the alt (xAI) route when the user has that key', () => {
    const r = resolveWorkerRoute(tts, new Set(['openrouter', 'xai']));
    expect(r).toMatchObject({ provider: 'xai', model: 'grok-voice-latest', keyService: 'xai' });
  });

  it('carries the route params', () => {
    expect(resolveWorkerRoute(extractor, new Set(['openrouter']))?.params).toEqual({
      extract_facts: true,
    });
  });

  it('returns null when no key exists for the default provider', () => {
    expect(resolveWorkerRoute(extractor, new Set(['xai']))).toBeNull();
    expect(resolveWorkerRoute(extractor, new Set())).toBeNull();
  });

  it('falls back to the default route when the alt key is absent', () => {
    // tts has an xAI alt, but with only an openrouter key it stays on default.
    expect(resolveWorkerRoute(tts, new Set(['openrouter']))?.provider).toBe('openrouter');
  });

  it('keeps the expected provider/model per worker kind (drift guard)', () => {
    const byKind = Object.fromEntries(MANIFEST_WORKERS.map((w) => [w.kind, w]));
    const expected: Record<string, { provider: string; model: string }> = {
      // Model asserted via the manifest constant, not a literal: this guard is
      // about the ROUTE (which provider each kind lands on), and a second copy
      // of the model id here would just be one more place to forget.
      extractor: { provider: 'openrouter', model: DEFAULT_WORKER_MODEL },
      summarizer: { provider: 'openrouter', model: DEFAULT_WORKER_MODEL },
      reflector: { provider: 'openrouter', model: DEFAULT_WORKER_MODEL },
      document: { provider: 'openrouter', model: DEFAULT_WORKER_MODEL },
      vision: { provider: 'openrouter', model: DEFAULT_WORKER_MODEL },
      image_gen: { provider: 'openrouter', model: 'google/gemini-3.1-flash-image' },
      tts: { provider: 'openrouter', model: 'x-ai/grok-voice-tts-1.0' },
      stt: { provider: 'openrouter', model: 'openai/gpt-4o-mini-transcribe' },
      search: { provider: 'openrouter', model: 'perplexity/sonar' },
      search_advanced: { provider: 'openrouter', model: 'perplexity/sonar-pro' },
    };
    for (const [kind, exp] of Object.entries(expected)) {
      expect(byKind[kind], `worker '${kind}' present`).toBeDefined();
      expect({ provider: byKind[kind]!.provider, model: byKind[kind]!.model }).toEqual(exp);
    }
    // tts/stt carry the dedicated xAI upgrade route.
    expect(byKind['tts']!.altModel).toBe('grok-voice-latest');
    expect(byKind['stt']!.altModel).toBe('grok-stt');
  });

  it('skips a worker whose only declared route has no key (alt without default key)', () => {
    const altOnly: ManifestWorker = {
      kind: 'tts',
      name: 'x',
      required: false,
      provider: 'openrouter',
      model: 'm',
      altKeyService: 'xai',
      altProvider: 'xai',
      altModel: 'alt',
    };
    // No keys at all → null even though an alt is declared.
    expect(resolveWorkerRoute(altOnly, new Set())).toBeNull();
    // Only xai → alt route is chosen.
    expect(resolveWorkerRoute(altOnly, new Set(['xai']))?.provider).toBe('xai');
  });
});
