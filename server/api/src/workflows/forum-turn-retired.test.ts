/**
 * The retired forum turn (member logins Phase 6): a no-op registered under the
 * old workflow name, so a forum turn left queued or in flight on a box that
 * upgrades has a function to run and ends cleanly. Without it DBOS finds no
 * function for the name and leaves the turn PENDING, retried on every boot.
 * (forum-turn-retired.db.test.ts proves the same on a real DBOS.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  registered: [] as { name: string; fn: (input: unknown) => Promise<unknown> }[],
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: (fn: (input: unknown) => Promise<unknown>, opts: { name: string }) => {
      h.registered.push({ name: opts.name, fn });
      return fn;
    },
    logger: { info: vi.fn(), error: vi.fn() },
  },
}));
// The real contract module (the name under test), without the whole runtime.
vi.mock('@mantle/runtime/assistant', async () => ({
  RETIRED_FORUM_TURN_WORKFLOW: (await import('../../../../packages/runtime/src/assistant/contract'))
    .RETIRED_FORUM_TURN_WORKFLOW,
}));

import { retiredForumTurn } from './forum-turn-retired';

describe('the retired forum turn workflow', () => {
  it("is registered under the old forum turn's exact name", () => {
    expect(h.registered.map((r) => r.name)).toEqual(['forumTurnWorkflow']);
    expect(h.registered[0]!.fn).toBe(retiredForumTurn);
  });

  it('the runner imports it (registration is an import side effect)', () => {
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/^import '\.\/workflows\/forum-turn-retired';$/m);
    // The real forum turn is gone from the runner.
    expect(main).not.toMatch(/workflows\/forum-turn';/);
  });

  it('ends the turn without running it', async () => {
    const input = {
      ownerId: 'o1',
      options: { contactId: 'c1', topicId: 't1', inboundPostId: 'p' },
    };
    expect(await retiredForumTurn(input)).toEqual({ retired: true });
  });

  it('never throws on an input it cannot read', async () => {
    for (const input of [undefined, null, 'x', { ownerId: 1 }, { ownerId: 'o1' }]) {
      await expect(retiredForumTurn(input)).resolves.toEqual({ retired: true });
    }
  });

  it('touches no forum table and no brain code (the tables are dropped, 0177)', () => {
    const src = readFileSync(new URL('./forum-turn-retired.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '@mantle\/(content|db)'/);
    expect(src).not.toMatch(/forum-archive-boot/);
  });
});
