import { describe, it, expect, vi } from 'vitest';
import { effectiveToolSlugs } from './skills';
import type { SkillForRuntime } from './skills';

const skill = (slug: string, toolSlugs: string[]): SkillForRuntime => ({
  id: slug,
  slug,
  name: slug,
  instructions: '',
  toolSlugs,
});

describe('effectiveToolSlugs', () => {
  it('unions and dedupes an agent and its skills tool slugs', () => {
    const out = effectiveToolSlugs(['a', 'b'], [skill('s1', ['b', 'c']), skill('s2', ['d'])]);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
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
    const out = effectiveToolSlugs(['x'], [skill('s', ['y'])]);
    expect([...out].sort()).toEqual(['x', 'y']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('unions granted tool-group tools (P3) and dedupes across all arms', () => {
    const out = effectiveToolSlugs(['a'], [skill('s', ['b'])], ['b', 'c', 'd']);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('defaults the group arm to empty (back-compat with 2-arg callers)', () => {
    const out = effectiveToolSlugs(['a', 'b'], []);
    expect([...out].sort()).toEqual(['a', 'b']);
  });
});
