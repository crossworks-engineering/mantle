import { describe, expect, it } from 'vitest';
import { buildFocusDirective } from './focus-directive';

describe('buildFocusDirective', () => {
  it('returns empty string when there are no marks', () => {
    expect(buildFocusDirective(undefined)).toBe('');
    expect(buildFocusDirective([])).toBe('');
  });

  it('drops blank / whitespace-only ids', () => {
    expect(buildFocusDirective(['  ', ''])).toBe('');
    const out = buildFocusDirective(['a1', '  ', 'b2']);
    expect(out).toContain('- a1');
    expect(out).toContain('- b2');
    // Only the two real ids — no stray bullet for the blank entry.
    expect(out.match(/^ {2}- /gm)?.length).toBe(2);
  });

  it('names every id and states the byte-for-byte contract', () => {
    const out = buildFocusDirective(['blk-1', 'blk-2', 'blk-3']);
    expect(out).toContain('ONLY');
    expect(out).toContain('byte-for-byte');
    for (const id of ['blk-1', 'blk-2', 'blk-3']) {
      expect(out).toContain(`- ${id}`);
    }
  });

  it('tells Pages to read then update by block id (uses the block tools)', () => {
    const out = buildFocusDirective(['x']);
    expect(out).toContain('page_block_get');
    expect(out).toContain('page_block_update');
  });

  it('tells Pages to skip page_blocks_list when it already has the ids', () => {
    const out = buildFocusDirective(['x']);
    expect(out).toContain('do NOT call page_blocks_list');
  });

  it('tells a delegating responder to relay the focus set verbatim', () => {
    const out = buildFocusDirective(['x']);
    expect(out).toContain('delegate');
    expect(out).toContain('verbatim');
  });
});
