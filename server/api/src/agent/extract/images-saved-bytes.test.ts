/**
 * A picture read from disk whose spool was dropped (another read of the same
 * bytes was done with it) is a failed save, counted as one not kept: never
 * an empty picture saved as the page, which would then count as pictured
 * and never be drawn again.
 */
import { describe, expect, it } from 'vitest';
import { savedBytesOf } from './images';

describe('the bytes of a picture to save', () => {
  it('a picture on disk is saved; one gone from disk is a failed save', () => {
    expect(savedBytesOf({ bytes: Buffer.from('png') }).toString()).toBe('png');
    expect(() => savedBytesOf({ bytes: Buffer.alloc(0) })).toThrow(/no longer on disk/);
  });
});
