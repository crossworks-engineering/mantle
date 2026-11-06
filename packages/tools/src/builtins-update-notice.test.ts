/**
 * update_notice_on / update_notice_off: admin only (the settings area, read
 * by the gate from the policy), a lift is never held for a client-sourced
 * turn but a block is, a linked brain or key must be named for either, and
 * each handler stores what the rule then reads. The store is stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolHandlerContext } from './types';

const stored: { value: unknown } = { value: undefined };
vi.mock('@mantle/content', () => ({
  setUpdateNotice: vi.fn(async (_userId: string, on: boolean) => {
    stored.value = on ? { setAt: new Date().toISOString(), version: '0.0.0' } : undefined;
    return stored.value;
  }),
}));

const { UPDATE_NOTICE_TOOLS } = await import('./builtins-update-notice');
const { setUpdateNotice } = await import('@mantle/content');

const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const tool = (slug: string) => {
  const def = UPDATE_NOTICE_TOOLS.find((t) => t.slug === slug);
  if (!def) throw new Error(`no ${slug}`);
  return def;
};

beforeEach(() => {
  stored.value = undefined;
  vi.mocked(setUpdateNotice).mockClear();
});

describe('update notice tools', () => {
  it('are the two, on the settings area, named by a peer', () => {
    expect(UPDATE_NOTICE_TOOLS.map((t) => t.slug)).toEqual([
      'update_notice_on',
      'update_notice_off',
    ]);
    for (const t of UPDATE_NOTICE_TOOLS) {
      expect(t.policy?.scope).toEqual({ area: 'settings' });
      expect(t.policy?.peerRisky).toBe(true);
      expect(t.policy?.effect).toBe('write');
    }
  });

  it('a block waits for a client-sourced turn, a lift does not', () => {
    expect(tool('update_notice_on').policy?.clientSourced).toMatchObject({ kind: 'always' });
    expect(tool('update_notice_off').policy?.clientSourced).toMatchObject({ kind: 'free' });
  });

  it('on stores and answers when it clears', async () => {
    const res = await tool('update_notice_on').handler({}, ctx);
    expect(setUpdateNotice).toHaveBeenCalledWith('o1', true);
    expect(res).toMatchObject({ ok: true, output: { on: true } });
    const until = (res as { output: { until: string } }).output.until;
    expect(Date.parse(until)).toBeGreaterThan(Date.now());
  });

  it('off clears', async () => {
    await tool('update_notice_on').handler({}, ctx);
    const res = await tool('update_notice_off').handler({}, ctx);
    expect(setUpdateNotice).toHaveBeenLastCalledWith('o1', false);
    expect(res).toEqual({ ok: true, output: { on: false, version: '0.0.0', until: null } });
  });

  it('a failed store is an error, not a throw', async () => {
    vi.mocked(setUpdateNotice).mockRejectedValueOnce(new Error('db down'));
    const res = await tool('update_notice_on').handler({}, ctx);
    expect(res).toMatchObject({ ok: false });
  });
});
