/**
 * Audit F14: a NUL (U+0000) in a member's note or page text made Postgres
 * refuse the write and the route answer 500. The body is cleaned before it is
 * validated; nothing else in it changes.
 */
import { describe, expect, it } from 'vitest';
import { readJsonNoNul, stripNul } from './strip-nul';

describe('stripNul', () => {
  it('strips NUL from strings, deep, and from object keys', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a\u0000b\u0000' }] }],
      'k\u0000ey': ['x\u0000', 1, true, null],
    };
    expect(stripNul(doc)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }],
      key: ['x', 1, true, null],
    });
  });

  it('returns the same value when there is no NUL', () => {
    const doc = { a: ['b', { c: 'd' }], n: 1 };
    expect(stripNul(doc)).toBe(doc);
    expect(stripNul('plain')).toBe('plain');
  });

  it('keeps a __proto__ key as data', () => {
    const parsed = JSON.parse('{"__proto__": {"x\\u0000": 1}}') as Record<string, unknown>;
    const out = stripNul(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
  });

  it('reads a request body with NUL removed, or null when it is not JSON', async () => {
    const req = (body: string) => new Request('http://x', { method: 'PUT', body });
    expect(await readJsonNoNul(req('{"content":"hi\\u0000there"}'))).toEqual({
      content: 'hithere',
    });
    expect(await readJsonNoNul(req('not json'))).toBeNull();
  });
});
