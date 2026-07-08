import { describe, expect, it } from 'vitest';
import { inScope, itemPathAfterRoot } from './scope';

const at = (parentPath: string | undefined, name?: string, id = 'item-1') => ({
  id,
  name,
  parentReference: parentPath === undefined ? undefined : { path: parentPath },
});

describe('itemPathAfterRoot', () => {
  it('joins the after-root parent path with the name', () => {
    expect(itemPathAfterRoot(at('/drives/d1/root:/Reports/2026', 'rbi.pdf'))).toBe(
      '/Reports/2026/rbi.pdf',
    );
  });

  it('handles root children (parent path ends at root:)', () => {
    expect(itemPathAfterRoot(at('/drives/d1/root:', 'top.docx'))).toBe('/top.docx');
  });

  it('decodes URL-encoded segments', () => {
    expect(itemPathAfterRoot(at('/drives/d1/root:/My%20Reports', 'a.pdf'))).toBe(
      '/My Reports/a.pdf',
    );
  });

  it('returns null without a usable parent path or name', () => {
    expect(itemPathAfterRoot(at(undefined, 'x.pdf'))).toBeNull();
    expect(itemPathAfterRoot(at('/drives/d1', 'x.pdf'))).toBeNull(); // no root: marker
    expect(itemPathAfterRoot(at('/drives/d1/root:/A', undefined))).toBeNull();
  });
});

describe('inScope', () => {
  const folder = { itemId: 'f1', path: '/Reports', isFolder: true };
  const file = { itemId: 'x1', path: '/Standalone/keep.pdf', isFolder: false };

  it('empty scope set means everything is in scope', () => {
    expect(inScope([], at('/drives/d1/root:/Anywhere', 'a.pdf'))).toBe(true);
  });

  it('folder scope matches the subtree by path prefix', () => {
    expect(inScope([folder], at('/drives/d1/root:/Reports', 'a.pdf'))).toBe(true);
    expect(inScope([folder], at('/drives/d1/root:/Reports/2026/Q2', 'b.pdf'))).toBe(true);
    expect(inScope([folder], at('/drives/d1/root:/Other', 'c.pdf'))).toBe(false);
    // Sibling with the scope path as a name prefix must NOT match.
    expect(inScope([folder], at('/drives/d1/root:/ReportsArchive', 'd.pdf'))).toBe(false);
  });

  it('file scope matches by item id even after a rename/move', () => {
    expect(inScope([file], at('/drives/d1/root:/Moved', 'renamed.pdf', 'x1'))).toBe(true);
    expect(inScope([file], at('/drives/d1/root:/Standalone', 'keep.pdf', 'other'))).toBe(true); // exact path
    expect(inScope([file], at('/drives/d1/root:/Standalone', 'drop.pdf', 'other'))).toBe(false);
  });

  it('items with no resolvable path only match file scopes by id', () => {
    expect(inScope([folder], at(undefined, 'a.pdf'))).toBe(false);
    expect(inScope([file], at(undefined, 'a.pdf', 'x1'))).toBe(true);
  });
});
