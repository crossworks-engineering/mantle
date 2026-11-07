/**
 * An owner turn's end clears its ui calls on every path (docs/agent-ui.md):
 * runAssistantTurn's outermost `finally` (agent-ui/end.ts). No database: the
 * agent lookup finds no assistant, so the turn fails before anything is
 * written, and the clear is stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cleared: [] as Array<{ turnId: string; loginId: string }> }));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // No assistant: every agent lookup answers no rows.
  const none = Object.assign(Promise.resolve([]), { limit: async () => [] });
  const chain = { from: () => chain, where: () => none };
  return {
    ...actual,
    db: { select: () => chain },
    clearTurnUiCalls: vi.fn(async (p: { turnId: string; loginId: string }) => {
      h.cleared.push(p);
      return 0;
    }),
  };
});

const { runAssistantTurn } = await import('./run-turn');

const LOGIN = '22222222-2222-4222-8222-222222222222';
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';

beforeEach(() => {
  h.cleared = [];
});

describe("an owner turn's end clears its ui calls", () => {
  it('a turn that fails: its own stream id and login, cleared', async () => {
    await expect(
      runAssistantTurn('owner-1', 'hello', {
        loginId: LOGIN,
        streamId: KEY,
        windowId: 'win_abcdefgh',
      }),
    ).rejects.toThrow(/No enabled assistant agent/);
    expect(h.cleared).toEqual([{ turnId: KEY, loginId: LOGIN }]);
  });

  it('a turn that named no window made no ui call: nothing to clear', async () => {
    await expect(
      runAssistantTurn('owner-1', 'hello', { loginId: LOGIN, streamId: KEY }),
    ).rejects.toThrow();
    expect(h.cleared).toEqual([]);
  });
});
