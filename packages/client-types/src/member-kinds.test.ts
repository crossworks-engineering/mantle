import { describe, expect, it } from 'vitest';
import { MEMBER_ITEM_KINDS, isMemberItemKind } from './member-kinds';

describe('member item kinds', () => {
  it('is the five kinds a space holds and the Library lists', () => {
    expect([...MEMBER_ITEM_KINDS]).toEqual(['page', 'note', 'draw', 'table', 'file']);
  });

  it('accepts a kind and refuses anything else', () => {
    for (const k of MEMBER_ITEM_KINDS) expect(isMemberItemKind(k)).toBe(true);
    for (const v of ['folder', 'app', 'Page', '', null, 3]) expect(isMemberItemKind(v)).toBe(false);
  });
});
