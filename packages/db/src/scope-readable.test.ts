/**
 * The Recall slug answer with no scope seen (arch A2b1 audit, M3): the next
 * free number only for a system actor and login(owner); every other actor
 * takes the random suffix.
 */
import { describe, expect, it } from 'vitest';
import { loginActor, runAsActor, runAsSystem, type Actor } from './actor';
import { scopeLacksAdmin } from './scope-readable';

/** A transaction that answers the scope probe with no scope set. */
const noScopeTx = {
  execute: async () => [{ active: false, narrow: false }],
};

const L = '0f0e0d0c-0b0a-4908-8706-050403020100';

describe('scopeLacksAdmin with no scope seen', () => {
  it('counts up for system and login(owner) only', async () => {
    expect(await runAsSystem('workflow:telegram-turn', () => scopeLacksAdmin(noScopeTx))).toBe(
      false,
    );
    expect(await runAsActor(loginActor(L, 'owner'), () => scopeLacksAdmin(noScopeTx))).toBe(false);
  });

  it('takes the random suffix for every other actor', async () => {
    const others: Actor[] = [
      loginActor(L, 'rw'),
      loginActor(L, 'ro'),
      { kind: 'assistant', agentId: null },
      { kind: 'link' },
      { kind: 'contact', canWrite: true },
      { kind: 'peer', peerId: null },
    ];
    for (const a of others) {
      expect(await runAsActor(a, () => scopeLacksAdmin(noScopeTx)), JSON.stringify(a)).toBe(true);
    }
  });

  it('follows a scope set on the transaction', async () => {
    const narrow = { execute: async () => [{ active: true, narrow: true }] };
    const admin = { execute: async () => [{ active: true, narrow: false }] };
    expect(await runAsSystem('x', () => scopeLacksAdmin(narrow))).toBe(true);
    expect(await runAsActor(loginActor(L, 'rw'), () => scopeLacksAdmin(admin))).toBe(false);
  });
});
