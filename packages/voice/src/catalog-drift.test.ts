/**
 * Catalogue drift: the half of discovery we used to throw away.
 *
 * `discoverModels` intersects a provider's live model list with our curated
 * catalogue and returns the overlap. The NON-overlap is the only automatic
 * signal that a catalogue has gone stale, and we were computing it on every
 * call and dropping it on the floor — which is how grok-4.5 shipped, went
 * unlisted, and stayed that way with every test green.
 *
 * Two directions matter and they fail differently:
 *   - unlisted: they serve it, we don't offer it → nobody can pick a model
 *     that exists. Silent; looks like the model doesn't exist.
 *   - stale: we offer it, they dropped it → picking it fails at request time.
 *
 * The alias rule is what makes the report readable rather than permanently
 * noisy. Anthropic's Models API returns dated snapshots; our catalogue holds
 * aliases. Without folding them together every snapshot reads as a new model
 * forever, and a report that is never clean gets ignored.
 */

import { describe, expect, it } from 'vitest';
import { catalogDrift } from './discover';
import { XAI_CHAT_MODELS } from './catalogs/xai';

/** The dated-snapshot rule the drift script applies to Anthropic. */
const datedAlias = (liveId: string) => /^(.*)-\d{8}$/.exec(liveId)?.[1];

describe('catalogDrift', () => {
  it('reports a model the provider serves that we do not list', () => {
    const drift = catalogDrift(['grok-4.5', 'grok-4.3'], ['grok-4.3']);
    expect(drift.unlisted).toEqual(['grok-4.5']);
    expect(drift.stale).toEqual([]);
  });

  it('reports a catalogue entry the provider no longer serves', () => {
    const drift = catalogDrift(['grok-4.3'], ['grok-4.3', 'grok-2-retired']);
    expect(drift.unlisted).toEqual([]);
    expect(drift.stale).toEqual(['grok-2-retired']);
  });

  it('is clean when both sides agree', () => {
    const drift = catalogDrift(['a', 'b'], ['b', 'a']);
    expect(drift).toEqual({ unlisted: [], stale: [] });
  });

  it('reports both directions at once', () => {
    const drift = catalogDrift(['new-1', 'kept'], ['kept', 'dropped']);
    expect(drift.unlisted).toEqual(['new-1']);
    expect(drift.stale).toEqual(['dropped']);
  });

  describe('dated aliases', () => {
    it('does not report a dated snapshot of a model we already list', () => {
      const drift = catalogDrift(['claude-haiku-4-5-20251001'], ['claude-haiku-4-5'], datedAlias);
      expect(drift.unlisted).toEqual([]);
    });

    it('does not report the alias as stale when only the dated id is live', () => {
      // The catalogue entry is fine — the provider is simply naming it by date.
      const drift = catalogDrift(['claude-haiku-4-5-20251001'], ['claude-haiku-4-5'], datedAlias);
      expect(drift.stale).toEqual([]);
    });

    it('still reports a dated model whose alias we do NOT list', () => {
      const drift = catalogDrift(['claude-opus-9-20260801'], ['claude-haiku-4-5'], datedAlias);
      expect(drift.unlisted).toEqual(['claude-opus-9-20260801']);
      expect(drift.stale).toEqual(['claude-haiku-4-5']);
    });

    it('leaves dated ids alone for providers with no alias rule', () => {
      const drift = catalogDrift(['gpt-5-20260101'], ['gpt-5']);
      expect(drift.unlisted).toEqual(['gpt-5-20260101']);
    });
  });

  it('deduplicates and sorts, so the report is stable across runs', () => {
    const drift = catalogDrift(['z', 'a', 'z'], []);
    expect(drift.unlisted).toEqual(['a', 'z']);
  });

  it('reports the whole catalogue as stale when a provider returns nothing', () => {
    // Guards the read: an empty live list is a real (if alarming) answer, not a
    // reason to silently report clean. The script only reaches here on a
    // SUCCESSFUL discovery — a failed call has no liveIds and is listed as
    // unchecked instead.
    const drift = catalogDrift([], ['a', 'b']);
    expect(drift.stale).toEqual(['a', 'b']);
  });
});

describe('xai catalogue', () => {
  it('lists grok-4.5 — the model that motivated the drift report', () => {
    const ids = XAI_CHAT_MODELS.map((m) => m.id);
    expect(ids).toContain('grok-4.5');
  });

  it('has no duplicate ids', () => {
    const ids = XAI_CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prices every entry, so the cost dashboard cannot silently show zero', () => {
    for (const m of XAI_CHAT_MODELS) {
      expect(m.inputPricePer1M, `${m.id} input price`).toBeGreaterThan(0);
      expect(m.outputPricePer1M, `${m.id} output price`).toBeGreaterThan(0);
    }
  });
});
