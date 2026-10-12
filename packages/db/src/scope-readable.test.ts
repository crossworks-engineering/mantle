/**
 * The Recall slug answer with no scope around the write (arch A2b): one
 * answer for every entry and every check mode, whatever actor is bound.
 */
import { describe, expect, it } from 'vitest';
import { loginActor, runAsActor, runAsSystem, type Actor } from './actor';
import { scopeLacksAdmin } from './scope-readable';

/** A transaction that answers the scope probe with no scope set. */
const noScopeTx = {
  execute: async () => [{ active: false, narrow: false }],
};

describe('scopeLacksAdmin with no scope', () => {
  it('counts up for every actor: the caller reads every item anyway', async () => {
    const actors: Actor[] = [
      loginActor('0f0e0d0c-0b0a-4908-8706-050403020100', 'rw'),
      loginActor('0f0e0d0c-0b0a-4908-8706-050403020100', 'ro'),
      loginActor('0f0e0d0c-0b0a-4908-8706-050403020100', 'owner'),
      { kind: 'assistant', agentId: null },
      { kind: 'link' },
    ];
    for (const a of actors) {
      expect(await runAsActor(a, () => scopeLacksAdmin(noScopeTx)), JSON.stringify(a)).toBe(false);
    }
    expect(await runAsSystem('workflow:telegram-turn', () => scopeLacksAdmin(noScopeTx))).toBe(
      false,
    );
  });

  it('follows a scope set on the transaction', async () => {
    const narrow = { execute: async () => [{ active: true, narrow: true }] };
    const admin = { execute: async () => [{ active: true, narrow: false }] };
    expect(await scopeLacksAdmin(narrow)).toBe(true);
    expect(await scopeLacksAdmin(admin)).toBe(false);
  });
});
