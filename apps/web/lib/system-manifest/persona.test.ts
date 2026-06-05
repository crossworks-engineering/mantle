import { describe, it, expect } from 'vitest';
import { resolveEffectivePersona, type PersonaCandidate } from './persona';
import { PERSONA_SLUG } from './manifest';

/**
 * Slug-flexible persona resolution. A freshly onboarded brain has the canonical
 * slug `assistant`; a brain hand-built before onboarding has an operator persona
 * (e.g. telegram-default/Saskia) and no `assistant` slug. The checker must
 * measure each against the persona it actually has — these guard that fallback.
 */
const a = (over: Partial<PersonaCandidate>): PersonaCandidate => ({
  slug: 'x',
  enabled: true,
  role: 'responder',
  priority: 100,
  ...over,
});

describe('resolveEffectivePersona', () => {
  it('prefers the canonical slug `assistant` when present', () => {
    const rows = [a({ slug: 'telegram-default' }), a({ slug: PERSONA_SLUG })];
    expect(resolveEffectivePersona(rows)?.slug).toBe(PERSONA_SLUG);
  });

  it('returns the canonical slug even when disabled (so it is honestly flagged)', () => {
    const rows = [a({ slug: PERSONA_SLUG, enabled: false }), a({ slug: 'telegram-default' })];
    const p = resolveEffectivePersona(rows);
    expect(p?.slug).toBe(PERSONA_SLUG);
    expect(p?.enabled).toBe(false);
  });

  it('falls back to the enabled responder when no `assistant` slug exists', () => {
    const rows = [a({ slug: 'telegram-default', role: 'responder' }), a({ slug: 'coder', role: 'custom' })];
    expect(resolveEffectivePersona(rows)?.slug).toBe('telegram-default');
  });

  it('prefers role `assistant` over `responder` in the fallback', () => {
    const rows = [
      a({ slug: 'saskia', role: 'responder', priority: 200 }),
      a({ slug: 'helper', role: 'assistant', priority: 50 }),
    ];
    expect(resolveEffectivePersona(rows)?.slug).toBe('helper');
  });

  it('breaks ties within a role by highest priority', () => {
    const rows = [
      a({ slug: 'low', role: 'responder', priority: 10 }),
      a({ slug: 'high', role: 'responder', priority: 90 }),
    ];
    expect(resolveEffectivePersona(rows)?.slug).toBe('high');
  });

  it('ignores disabled responders in the fallback', () => {
    const rows = [a({ slug: 'off', role: 'responder', enabled: false })];
    expect(resolveEffectivePersona(rows)).toBeNull();
  });

  it('returns null when there is no persona candidate at all', () => {
    const rows = [a({ slug: 'coder', role: 'custom' }), a({ slug: 'pages', role: 'custom' })];
    expect(resolveEffectivePersona(rows)).toBeNull();
  });
});
