/**
 * Pinned-model drift.
 *
 * Most of these are regression tests for false positives the naive version
 * produced against the REAL fleet on 2026-08-04 — it reported a healthy set of
 * boxes as having three retired models. Every one of those was the checker
 * being wrong, not the fleet. A drift report that cries wolf gets muted, and
 * then the genuine delisting goes unread too, so the false-positive cases
 * matter more here than the true-positive one.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPin,
  classifyPins,
  isAliasPin,
  isNewer,
  parseFamily,
  type CatalogEntry,
  type PinnedModel,
  type ProviderCatalog,
} from './pinned-model-drift';

const chat = (id: string): CatalogEntry => ({ id, kind: 'chat' });
const pin = (over: Partial<PinnedModel> = {}): PinnedModel => ({
  ref: 'agent:assistant',
  provider: 'openrouter',
  model: 'anthropic/claude-opus-4.8',
  kind: 'chat',
  ...over,
});
const ok = (entries: CatalogEntry[]): ProviderCatalog => ({ ok: true, entries });

describe('parseFamily', () => {
  it('splits vendor/family from a dotted version', () => {
    expect(parseFamily('anthropic/claude-opus-4.8')).toEqual({
      family: 'anthropic/claude-opus',
      version: [4, 8],
    });
  });

  it('ignores a variant suffix when deriving the family', () => {
    expect(parseFamily('anthropic/claude-sonnet-5:free')?.family).toBe('anthropic/claude-sonnet');
  });

  it('returns null for an id with no orderable version', () => {
    expect(parseFamily('perplexity/sonar')).toBeNull();
    expect(parseFamily('openai/gpt-4o-mini-transcribe')).toBeNull();
  });
});

describe('isNewer', () => {
  it('compares segments as integers, not decimals', () => {
    // x-ai ships grok-4.5 AND grok-4.20; as a decimal 4.20 < 4.5, as release
    // numbering 4.20 > 4.5. The report states this rule out loud because it is
    // the one judgement here that could reasonably go the other way.
    expect(isNewer([4, 20], [4, 5])).toBe(true);
    expect(isNewer([4, 5], [4, 20])).toBe(false);
  });

  it('treats a missing segment as zero', () => {
    expect(isNewer([5], [4, 8])).toBe(true);
    expect(isNewer([4], [4, 1])).toBe(false);
    expect(isNewer([4, 0], [4])).toBe(false);
  });
});

describe('classifyPin — the false positives', () => {
  it('does NOT flag an auto-updating alias as missing', () => {
    // `~x-ai/grok-latest` is a real current OpenRouter id; the tilde is their
    // alias marker. Hand-typing it without the tilde is what produced the first
    // false positive against jason-prod's live persona.
    const p = pin({ model: '~x-ai/grok-latest' });
    expect(isAliasPin(p.model)).toBe(true);
    expect(classifyPin(p, ok([chat('~x-ai/grok-latest'), chat('x-ai/grok-4.5')])).status).toBe(
      'current',
    );
  });

  it('does not tell an alias that something newer exists', () => {
    // Tracking the family is the point of pinning an alias.
    const v = classifyPin(
      pin({ model: '~x-ai/grok-latest' }),
      ok([chat('~x-ai/grok-latest'), chat('x-ai/grok-4.20')]),
    );
    expect(v.status).toBe('current');
  });

  it('does NOT flag a TTS pin against a chat-only catalogue', () => {
    // The second false positive: OpenRouter's /models enumerates chat models
    // only — no tts/stt id appears in it at all — so a voice worker checked
    // against it reads as retired. Both dev and jason-prod tripped this.
    const v = classifyPin(
      pin({ ref: 'worker:tts', model: 'x-ai/grok-voice-tts-1.0', kind: 'tts' }),
      ok([chat('anthropic/claude-sonnet-5'), chat('x-ai/grok-4.5')]),
    );
    expect(v.status).toBe('unchecked');
    expect(v.status === 'unchecked' && v.reason).toContain('no tts models');
  });

  it('does NOT flag an STT pin against a chat-only catalogue', () => {
    const v = classifyPin(
      pin({ ref: 'worker:stt', model: 'openai/gpt-4o-mini-transcribe', kind: 'stt' }),
      ok([chat('anthropic/claude-sonnet-5')]),
    );
    expect(v.status).toBe('unchecked');
  });

  it('reports an unreachable provider as unchecked, never missing', () => {
    // Absence of evidence. A missing key or a provider with no list API says
    // nothing about whether the pin is valid.
    for (const reason of ['no list API', 'no stored key', 'HTTP 503']) {
      const v = classifyPin(pin(), { ok: false, reason });
      expect(v.status).toBe('unchecked');
      expect(v.status === 'unchecked' && v.reason).toBe(reason);
    }
  });

  it('decides every cannot-see case before judging the id', () => {
    // Belt and braces: an unreachable catalogue must not produce `missing`
    // even when the pin genuinely is absent from what little we hold.
    expect(classifyPin(pin({ model: 'totally/made-up' }), { ok: false, reason: 'x' }).status).toBe(
      'unchecked',
    );
  });
});

describe('classifyPin — the real signal', () => {
  it('flags a chat pin absent from a catalogue that covers chat', () => {
    const v = classifyPin(
      pin({ model: 'anthropic/claude-opus-3.9' }),
      ok([chat('anthropic/claude-opus-4.8')]),
    );
    expect(v.status).toBe('missing');
  });

  it('reports newer same-family versions, sorted', () => {
    const v = classifyPin(
      pin({ model: 'anthropic/claude-opus-4.7' }),
      ok([
        chat('anthropic/claude-opus-4.7'),
        chat('anthropic/claude-opus-4.8'),
        chat('anthropic/claude-opus-5.0'),
        chat('anthropic/claude-sonnet-5'), // different family — not a candidate
      ]),
    );
    expect(v.status).toBe('newer-in-family');
    expect(v.status === 'newer-in-family' && v.candidates).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-opus-5.0',
    ]);
  });

  it('does not treat a different family as a successor', () => {
    // opus → sonnet is a different product line, not an upgrade path.
    const v = classifyPin(
      pin({ model: 'anthropic/claude-opus-4.8' }),
      ok([chat('anthropic/claude-opus-4.8'), chat('anthropic/claude-sonnet-5')]),
    );
    expect(v.status).toBe('current');
  });

  it('calls an unversioned but present id current rather than guessing', () => {
    const v = classifyPin(
      pin({ model: 'perplexity/sonar' }),
      ok([chat('perplexity/sonar'), chat('perplexity/sonar-pro')]),
    );
    expect(v.status).toBe('current');
  });

  it('treats an unclassified catalogue entry as chat', () => {
    // Bare-id endpoints (OpenAI, Anthropic direct) return no kind; in practice
    // those lists are chat models.
    const v = classifyPin(pin({ model: 'claude-sonnet-5' }), ok([{ id: 'claude-sonnet-5' }]));
    expect(v.status).toBe('current');
  });
});

describe('classifyPins', () => {
  it('buckets a mixed fleet and counts everything once', () => {
    const catalogs = new Map<string, ProviderCatalog>([
      [
        'openrouter',
        ok([
          chat('anthropic/claude-opus-4.7'), // agent:b's pin — present, but superseded
          chat('anthropic/claude-opus-4.8'),
          chat('anthropic/claude-sonnet-5'),
        ]),
      ],
      ['xai', { ok: false, reason: 'no stored key' }],
    ]);
    const r = classifyPins(
      [
        pin({ ref: 'agent:a', model: 'anthropic/claude-sonnet-5' }),
        pin({ ref: 'agent:b', model: 'anthropic/claude-opus-4.7' }),
        pin({ ref: 'agent:c', model: 'anthropic/claude-opus-3.0' }),
        pin({ ref: 'worker:tts', model: 'grok-voice', kind: 'tts' }),
        pin({ ref: 'agent:d', provider: 'xai', model: 'grok-4' }),
      ],
      catalogs,
    );
    expect(r.checked).toBe(5);
    expect(r.current.map((v) => v.pin.ref)).toEqual(['agent:a']);
    expect(r.newerInFamily.map((v) => v.pin.ref)).toEqual(['agent:b']);
    expect(r.missing.map((v) => v.pin.ref)).toEqual(['agent:c']);
    expect(r.unchecked.map((v) => v.pin.ref)).toEqual(['worker:tts', 'agent:d']);
    expect(r.current.length + r.newerInFamily.length + r.missing.length + r.unchecked.length).toBe(
      r.checked,
    );
  });

  it('treats a provider that was never fetched as unchecked', () => {
    const r = classifyPins([pin({ provider: 'cohere' })], new Map());
    expect(r.unchecked).toHaveLength(1);
    expect(r.missing).toHaveLength(0);
  });
});
