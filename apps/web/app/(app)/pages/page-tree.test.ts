import { describe, expect, it } from 'vitest';
import { buildChildrenIndex, type TreeInput } from './page-tree';

const p = (id: string, parentId: string | null, title: string): TreeInput => ({
  id,
  parentId,
  title,
});

describe('buildChildrenIndex', () => {
  it('groups children under their parent and top-level pages under null', () => {
    const idx = buildChildrenIndex([
      p('a', null, 'Alpha'),
      p('b', 'a', 'Beta'),
      p('c', 'a', 'Gamma'),
    ]);
    expect(idx.get(null)?.map((n) => n.id)).toEqual(['a']);
    expect(idx.get('a')?.map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('sorts siblings by title (not input order)', () => {
    const idx = buildChildrenIndex([
      p('a', null, 'Zeta'),
      p('b', null, 'Alpha'),
      p('c', null, 'Mu'),
    ]);
    expect(idx.get(null)?.map((n) => n.title)).toEqual(['Alpha', 'Mu', 'Zeta']);
  });

  it('treats a page with an unresolvable parent as a root (orphan-as-root)', () => {
    // 'b' points at a parent that isn't in the loaded set (e.g. beyond the
    // load limit) — it must still surface, as a top-level row.
    const idx = buildChildrenIndex([p('a', null, 'Alpha'), p('b', 'missing', 'Beta')]);
    expect(idx.get(null)?.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('handles deep nesting (grandchildren)', () => {
    const idx = buildChildrenIndex([
      p('a', null, 'Root'),
      p('b', 'a', 'Child'),
      p('c', 'b', 'Grandchild'),
    ]);
    expect(idx.get('a')?.map((n) => n.id)).toEqual(['b']);
    expect(idx.get('b')?.map((n) => n.id)).toEqual(['c']);
  });

  it('is cycle-safe: a mutual parent cycle yields no roots (renderer never recurses into it)', () => {
    // A.parent=B, B.parent=A — both resolve, so neither is a root. The tree
    // renderer starts from null and thus never reaches them: no infinite loop.
    const idx = buildChildrenIndex([p('a', 'b', 'A'), p('b', 'a', 'B')]);
    expect(idx.get(null) ?? []).toEqual([]);
  });

  it('returns an empty index for no pages', () => {
    expect(buildChildrenIndex([]).size).toBe(0);
  });
});
