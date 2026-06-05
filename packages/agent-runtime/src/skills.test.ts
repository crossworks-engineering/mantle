import { describe, it, expect, vi } from 'vitest';
import { effectiveToolSlugs } from './skills';

describe('effectiveToolSlugs', () => {
  it('unions an agent and its granted-group tools, deduped', () => {
    const out = effectiveToolSlugs(['a', 'b'], ['b', 'c', 'd']);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('defaults the group arm to empty (agent-only grant)', () => {
    const out = effectiveToolSlugs(['a', 'b']);
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  it('caps the union and logs the dropped slugs (not silent)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 600 }, (_, i) => `t${i}`);
    const out = effectiveToolSlugs(many, []);
    expect(out).toHaveLength(512);
    expect(out[0]).toBe('t0'); // insertion order preserved; head kept
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('exceeds cap');
    warn.mockRestore();
  });

  it('leaves a normal-sized union untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = effectiveToolSlugs(['x'], ['y']);
    expect([...out].sort()).toEqual(['x', 'y']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
