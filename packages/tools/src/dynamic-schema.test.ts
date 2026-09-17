/**
 * The `invoke_agent` dynamic-schema hook: the delegate-slug enum patch (the
 * v0.82.2 hallucinated-slug guard) plus the appended delegate roster. The
 * invariant under test is the DEGRADATION ORDER — the roster is best-effort,
 * the enum is not: a roster failure must still return the enum patch, never
 * null and never a throw that would drop the whole patch in the tool loop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildDelegateRoster = vi.fn<(ownerId: string, d: readonly string[]) => Promise<string>>();
vi.mock('./delegate-roster', () => ({
  buildDelegateRoster: (ownerId: string, d: readonly string[]) => buildDelegateRoster(ownerId, d),
}));

import { getDynamicSchema } from './dynamic-schema';

const CURRENT = {
  description: 'Hand off to another agent.',
  parameters: {
    type: 'object',
    required: ['agent_slug', 'prompt'],
    properties: {
      agent_slug: { type: 'string', description: 'Slug of the target agent.' },
      prompt: { type: 'string' },
    },
  } as Record<string, unknown>,
};

const agentSlug = (patch: { parameters?: Record<string, unknown> } | null) =>
  ((patch?.parameters?.properties as Record<string, unknown>).agent_slug ?? {}) as Record<
    string,
    unknown
  >;

describe('invoke_agent dynamic-schema hook', () => {
  const hook = getDynamicSchema('invoke_agent')!;

  beforeEach(() => {
    buildDelegateRoster.mockReset();
  });

  it('is registered', () => {
    expect(hook).toBeTruthy();
  });

  it('appends the roster to the description AND still patches the enum', async () => {
    buildDelegateRoster.mockResolvedValue('- researcher — Web research (Search the live web.)');
    const patch = await hook(CURRENT, { ownerId: 'o1', delegateTo: ['researcher', 'pages'] });
    expect(patch).toBeTruthy();
    expect(agentSlug(patch).enum).toEqual(['researcher', 'pages']);
    expect(patch!.description).toContain('Hand off to another agent.');
    expect(patch!.description).toContain('what each currently carries');
    expect(patch!.description).toContain('Web research');
    expect(buildDelegateRoster).toHaveBeenCalledWith('o1', ['researcher', 'pages']);
  });

  it('roster failure degrades to the enum-only patch (the enum never regresses)', async () => {
    buildDelegateRoster.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patch = await hook(CURRENT, { ownerId: 'o1', delegateTo: ['researcher'] });
    expect(patch).toBeTruthy();
    expect(agentSlug(patch).enum).toEqual(['researcher']);
    expect(patch!.description).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('delegate roster'),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('an empty roster leaves the description untouched', async () => {
    buildDelegateRoster.mockResolvedValue('');
    const patch = await hook(CURRENT, { ownerId: 'o1', delegateTo: ['researcher'] });
    expect(agentSlug(patch).enum).toEqual(['researcher']);
    expect(patch!.description).toBeUndefined();
  });

  it('returns null (static schema) when there is no delegate list', async () => {
    expect(await hook(CURRENT, { ownerId: 'o1' })).toBeNull();
    expect(await hook(CURRENT, { ownerId: 'o1', delegateTo: [] })).toBeNull();
    expect(buildDelegateRoster).not.toHaveBeenCalled();
  });
});
