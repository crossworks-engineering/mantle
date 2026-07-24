import { describe, expect, it } from 'vitest';
import { nodeHref } from './node-href';

describe('nodeHref', () => {
  it('routes pages and notes to their detail surfaces', () => {
    expect(nodeHref('page', 'abc')).toBe('/pages/abc');
    expect(nodeHref('note', 'xyz')).toBe('/notes/xyz');
  });

  it('returns null for types without a detail route', () => {
    expect(nodeHref('entity', 'e1')).toBeNull();
    expect(nodeHref('email', 'm1')).toBeNull();
    expect(nodeHref(null, 'n1')).toBeNull();
    expect(nodeHref(undefined, 'n1')).toBeNull();
  });
});
