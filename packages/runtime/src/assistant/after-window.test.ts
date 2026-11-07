/**
 * After a ui tool ran, what the turn keeps of its later tool calls drops
 * what the window may have shown (docs/agent-ui.md): the thought trail's
 * labels read no arguments from the first ui call on, and the tool-outcome
 * ledger keeps a failure's code only. Pure.
 */
import { describe, expect, it } from 'vitest';
import { buildPersistedTrail } from './responder-loop';
import { summarizeToolOutcomes } from '../agent/tool-loop';

const SECRET = 'Q3 salaries of Pat Jones';

describe('the thought trail', () => {
  it('labels from the first ui call on carry no argument', () => {
    const calls = [
      { slug: 'search', argsJson: JSON.stringify({ query: 'before the window' }), durationMs: 1 },
      { slug: 'ui_screen', argsJson: '{}', durationMs: 1 },
      { slug: 'search', argsJson: JSON.stringify({ query: SECRET }), durationMs: 1 },
      { slug: 'page_get', argsJson: JSON.stringify({ title: SECRET }), durationMs: 1 },
    ];
    const trail = buildPersistedTrail(calls);
    expect(JSON.stringify(trail)).not.toContain(SECRET);
    expect(JSON.stringify(trail)).not.toContain('Q3');
    // A turn with no ui call keeps its labels as before.
    const plain = buildPersistedTrail([calls[2]!]);
    expect(JSON.stringify(plain)).toContain('Q3');
  });
});

describe('the tool-outcome ledger', () => {
  it("a failure's text after the first ui call is its code only", () => {
    const base = { durationMs: 1, argsJson: '{}' };
    const stats = summarizeToolOutcomes([
      { ...base, slug: 'page_get', status: 'error', error: 'not_found: before the window' },
      { ...base, slug: 'ui_click', status: 'error', error: `needs_user: ${SECRET}` },
      { ...base, slug: 'page_get', status: 'error', error: `not_found: page ${SECRET}` },
    ] as never);
    expect(stats.failures).toEqual([
      { slug: 'page_get', error: 'not_found: before the window' },
      { slug: 'ui_click', error: 'needs_user' },
      { slug: 'page_get', error: 'not_found' },
    ]);
  });
});
