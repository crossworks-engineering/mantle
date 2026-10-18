/**
 * Plan v3 S3 fix round 4 (L3): profileRowWritable asks the one SQL
 * function of profiles' write rule (mantle_profile_writable, 0302) in a
 * read transaction (a savepoint inside an open one), reads a refusal
 * (42501) as no and throws every other error; noteInboundChannel, which
 * its caller does not wait for, never rejects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: true as boolean,
  answer: null as unknown,
  asked: [] as string[],
  inserts: 0,
}));

vi.mock('@mantle/db', () => {
  const insertChain = {
    values: () => insertChain,
    onConflictDoUpdate: async () => {
      h.inserts += 1;
    },
  };
  return {
    db: { insert: () => insertChain },
    profiles: { preferences: 'preferences', userId: 'user_id' },
    resolveSingleOwnerId: async () => null,
    currentWorkspaceScope: () => (h.scope ? { kind: 'user' } : null),
    pgErrorCode: (e: unknown) => (e as { code?: string } | null)?.code ?? null,
    readTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async (q: { queryChunks?: unknown[] }) => {
          h.asked.push(JSON.stringify(q.queryChunks ?? q));
          if (h.answer instanceof Error) throw h.answer;
          return h.answer;
        },
      }),
  };
});

const USER = '00000000-0000-4000-8000-00000000000c';
const refusal = (code: string) => Object.assign(new Error('refused'), { code });

describe('profileRowWritable', () => {
  beforeEach(() => {
    h.scope = true;
    h.answer = [{ ok: true }];
    h.asked = [];
    h.inserts = 0;
  });

  it('asks mantle_profile_writable in a read transaction', async () => {
    const { profileRowWritable } = await import('./profile-preferences');
    expect(await profileRowWritable(USER)).toBe(true);
    expect(h.asked.join(' ')).toContain('mantle_profile_writable');
    h.answer = [{ ok: false }];
    expect(await profileRowWritable(USER)).toBe(false);
    h.answer = [{ ok: null }];
    expect(await profileRowWritable(USER)).toBe(false);
  });

  it('system work (no workspace scope) may, without asking', async () => {
    const { profileRowWritable } = await import('./profile-preferences');
    h.scope = false;
    expect(await profileRowWritable(USER)).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it('reads 42501 as no and throws any other error', async () => {
    const { profileRowWritable } = await import('./profile-preferences');
    h.answer = refusal('42501');
    expect(await profileRowWritable(USER)).toBe(false);
    h.answer = refusal('57P01');
    await expect(profileRowWritable(USER)).rejects.toThrow('refused');
    h.answer = new Error('connection ended');
    await expect(profileRowWritable(USER)).rejects.toThrow('connection ended');
  });

  it('noteInboundChannel never rejects: a failed check is logged and the write skipped', async () => {
    const { noteInboundChannel } = await import('./profile-preferences');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.answer = refusal('57P01');
    await expect(noteInboundChannel(USER, 'telegram')).resolves.toBeUndefined();
    expect(h.inserts).toBe(0);
    expect(err).toHaveBeenCalled();
    h.answer = [{ ok: true }];
    await noteInboundChannel(USER, 'telegram');
    expect(h.inserts).toBe(1);
    err.mockRestore();
  });
});
