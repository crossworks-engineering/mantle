/**
 * The boot's refusal of a brain off workspaces (arch A7): which skip
 * reasons refuse it. A fresh install with no owner yet serves (its signup
 * switches it); a brain on workspaces serves; anything else ("clients
 * present", a switch that failed) is refused, with words that name the
 * operator's manual switch. No database: the skip reason is stood in.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ why: null as string | null }));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { execute: async () => [{ why: h.why }] },
}));

import { unmigratedBrainReason, unmigratedBrainRefusal } from './workspaces-migrate';

describe('the boot refuses an unmigrated brain (A7)', () => {
  it('a brain on workspaces and a fresh install with no owner serve', async () => {
    h.why = null;
    expect(await unmigratedBrainReason()).toBeNull();
    h.why = 'no brain anchor yet';
    expect(await unmigratedBrainReason()).toBeNull();
  });

  it('a box that reports clients present, or a switch that failed, is refused', async () => {
    h.why = 'clients present: 1 client login(s), 0 client-level item(s)';
    expect(await unmigratedBrainReason()).toBe(h.why);
    h.why = 'no workspaces yet';
    expect(await unmigratedBrainReason()).toBe('no workspaces yet');
  });

  it('the refusal names the reason and the manual switch path', () => {
    const text = unmigratedBrainRefusal(
      'clients present: 1 client login(s), 0 client-level item(s)',
    );
    expect(text).toContain('clients present');
    expect(text).toContain('mantle_ws_migrate_locked');
    expect(text).toContain('Operator notes');
  });
});
