/**
 * The retired forum turn (member logins Phase 6): a no-op registered under the
 * old workflow name, so a forum turn left queued or in flight on a box that
 * upgrades has a function to run and ends cleanly. Without it DBOS finds no
 * function for the name and leaves the turn PENDING, retried on every boot.
 * (forum-turn-retired.db.test.ts proves the same on a real DBOS.)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  registered: [] as { name: string; fn: (input: unknown) => Promise<unknown> }[],
  failed: 0,
  failCalls: [] as unknown[][],
  bootRuns: 0,
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
vi.mock('@mantle/content', () => ({
  failPendingForumReplies: vi.fn(async (...args: unknown[]) => {
    h.failCalls.push(args);
    return h.failed;
  }),
}));
// The real contract module (the name under test), without the whole runtime.
vi.mock('@mantle/runtime/assistant', async () => ({
  RETIRED_FORUM_TURN_WORKFLOW: (await import('../../../../packages/runtime/src/assistant/contract'))
    .RETIRED_FORUM_TURN_WORKFLOW,
}));
vi.mock('../forum-archive-boot', () => ({
  runForumArchiveBootTask: vi.fn(async () => {
    h.bootRuns++;
  }),
}));

import { retiredForumTurn } from './forum-turn-retired';

beforeEach(() => {
  h.failed = 0;
  h.failCalls = [];
  h.bootRuns = 0;
});

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

  it("fails the topic's pending reply and lets the archive export run", async () => {
    h.failed = 1;
    const input = {
      ownerId: 'o1',
      options: { contactId: 'c1', topicId: 't1', inboundPostId: 'p' },
    };
    expect(await retiredForumTurn(input)).toEqual({ retired: true, failedReplies: 1 });
    expect(h.failCalls).toEqual([['o1', { topicId: 't1' }]]);
    expect(h.bootRuns).toBe(1);
  });

  it('with nothing pending it only ends the workflow', async () => {
    expect(await retiredForumTurn({ ownerId: 'o1', options: { topicId: 't1' } })).toEqual({
      retired: true,
      failedReplies: 0,
    });
    expect(h.bootRuns).toBe(0);
  });

  it('never throws on an input it cannot read', async () => {
    for (const input of [undefined, null, 'x', { ownerId: 1 }, { ownerId: 'o1' }]) {
      await expect(retiredForumTurn(input)).resolves.toEqual({ retired: true, failedReplies: 0 });
    }
    expect(h.failCalls).toEqual([]);
  });
});
