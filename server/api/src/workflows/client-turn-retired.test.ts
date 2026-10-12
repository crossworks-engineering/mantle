/**
 * The retired client chat turn (workspaces W5c): a no-op registered under the
 * old workflow name, so a client turn left queued or in flight on a box that
 * upgrades has a function to run and ends cleanly. Without it DBOS finds no
 * function for the name and leaves the turn PENDING, retried on every boot.
 * (The forum's twin, forum-turn-retired.db.test.ts, proves the mechanism on
 * a real DBOS.)
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
  RETIRED_CLIENT_TURN_WORKFLOW: (
    await import('../../../../packages/runtime/src/assistant/contract')
  ).RETIRED_CLIENT_TURN_WORKFLOW,
}));

import { retiredClientTurn } from './client-turn-retired';

describe('the retired client turn workflow', () => {
  it("is registered under the old client turn's exact name", async () => {
    expect(h.registered.map((r) => r.name)).toEqual(['clientTurnWorkflow']);
    // Through registerActorWorkflow (arch A2a): the run ends the same way.
    expect(await h.registered[0]!.fn({})).toEqual({ retired: true });
  });

  it('the runner imports it, and no longer registers the client queue', () => {
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/^import '\.\/workflows\/client-turn-retired';$/m);
    expect(main).not.toMatch(/workflows\/client-turn';/);
    expect(main).not.toMatch(/registerQueue\(CLIENT_TURN_QUEUE/);
  });

  it('ends the turn without running it', async () => {
    const input = { ownerId: 'o1', text: 'hi', options: { loginId: 'l1', sessionEpoch: 0 } };
    expect(await retiredClientTurn(input)).toEqual({ retired: true });
  });

  it('never throws on an input it cannot read', async () => {
    for (const input of [undefined, null, 'x', { ownerId: 1 }, { options: null }]) {
      await expect(retiredClientTurn(input)).resolves.toEqual({ retired: true });
    }
  });

  it('touches no brain code', () => {
    const src = readFileSync(new URL('./client-turn-retired.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '@mantle\/(content|db|tools)'/);
  });
});
