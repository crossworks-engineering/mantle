import { describe, it, expect } from 'vitest';
import { computeGroupToolFindings, type GroupCheckRow } from './group-checks';

/**
 * Pins the two silent-loss surfacing rules the audit added
 * (docs/audit-brief-tools-skills.md M1/M2): a disabled manifest group, and a
 * custom group referencing a disabled tool, must both show up in the integrity
 * report — the runtime drops them with no error.
 */

const MANIFEST = new Set(['email', 'notes', 'memory-core']);
const ENABLED_TOOLS = new Set(['email_send', 'note_create', 'search_nodes']);

const row = (over: Partial<GroupCheckRow> & { slug: string }): GroupCheckRow => ({
  enabled: true,
  toolSlugs: [],
  ...over,
});

describe('computeGroupToolFindings', () => {
  it('is clean when every manifest group is seeded, enabled, and resolves', () => {
    const rows = [
      row({ slug: 'email', toolSlugs: ['email_send'] }),
      row({ slug: 'notes', toolSlugs: ['note_create'] }),
      row({ slug: 'memory-core', toolSlugs: ['search_nodes'] }),
    ];
    expect(computeGroupToolFindings(MANIFEST, rows, ENABLED_TOOLS)).toEqual([]);
  });

  it('flags a manifest group that is not seeded', () => {
    const rows = [
      row({ slug: 'email', toolSlugs: ['email_send'] }),
      row({ slug: 'notes', toolSlugs: ['note_create'] }),
      // memory-core missing entirely
    ];
    const f = computeGroupToolFindings(MANIFEST, rows, ENABLED_TOOLS);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: 'memory-core' });
    expect(f[0]?.detail).toMatch(/not seeded/);
  });

  it('M1: flags a DISABLED manifest group (the self-heal floor silently skips it)', () => {
    const rows = [
      row({ slug: 'email', enabled: false, toolSlugs: ['email_send'] }),
      row({ slug: 'notes', toolSlugs: ['note_create'] }),
      row({ slug: 'memory-core', toolSlugs: ['search_nodes'] }),
    ];
    const f = computeGroupToolFindings(MANIFEST, rows, ENABLED_TOOLS);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe('email');
    expect(f[0]?.detail).toMatch(/disabled/);
    expect(f[0]?.detail).toMatch(/self-heal floor/);
  });

  it('flags a manifest group whose member tool has no enabled row', () => {
    const rows = [
      row({ slug: 'email', toolSlugs: ['email_send', 'email_ghost'] }),
      row({ slug: 'notes', toolSlugs: ['note_create'] }),
      row({ slug: 'memory-core', toolSlugs: ['search_nodes'] }),
    ];
    const f = computeGroupToolFindings(MANIFEST, rows, ENABLED_TOOLS);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe('email:email_ghost');
  });

  it('M2: flags a CUSTOM group referencing a disabled tool', () => {
    const rows = [
      row({ slug: 'email', toolSlugs: ['email_send'] }),
      row({ slug: 'notes', toolSlugs: ['note_create'] }),
      row({ slug: 'memory-core', toolSlugs: ['search_nodes'] }),
      row({ slug: 'my-custom', toolSlugs: ['note_create', 'gone_tool'] }),
    ];
    const f = computeGroupToolFindings(MANIFEST, rows, ENABLED_TOOLS);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe('my-custom:gone_tool');
    expect(f[0]?.detail).toMatch(/custom tool group/);
  });

  it('leaves a DISABLED custom group alone (parking is operator discretion)', () => {
    const rows = [
      row({ slug: 'email', toolSlugs: ['email_send'] }),
      row({ slug: 'notes', toolSlugs: ['note_create'] }),
      row({ slug: 'memory-core', toolSlugs: ['search_nodes'] }),
      // disabled custom group referencing a missing tool — not flagged here
      // (a disabled group that's actually GRANTED is caught by dangling-groups).
      row({ slug: 'parked', enabled: false, toolSlugs: ['gone_tool'] }),
    ];
    expect(computeGroupToolFindings(MANIFEST, rows, ENABLED_TOOLS)).toEqual([]);
  });
});
