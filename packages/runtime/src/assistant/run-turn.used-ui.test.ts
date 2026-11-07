/**
 * An owner turn's reply is the login's private output when it saw the
 * person's window (docs/agent-ui.md): a ui tool ran in it, or the history the
 * model saw holds a reply that did. Turn N used a ui tool; turn N+1 used none
 * but can quote N, so it is marked too, and so is N+2 quoting N+1 (the mark
 * rides on each reply's row, `data.used_ui`). A history without the mark
 * leaves the turn unmarked. No database: the rows are the `data` the
 * conversation reads back.
 */
import { describe, expect, it } from 'vitest';

const { turnUsedUi } = await import('./run-turn');
const { rowSawWindow } = await import('../agent/conversation');

/** One owner turn: what its reply row's data holds after finalize. */
function turn(history: readonly unknown[], toolCalls: readonly { slug: string }[]) {
  const usedUi = turnUsedUi(
    toolCalls,
    history.some((d) => rowSawWindow(d)),
  );
  return { data: usedUi ? { used_ui: true } : {}, usedUi };
}

describe("an owner turn's private-output mark", () => {
  it('turn N+1 quoting turn N (a ui tool ran in N) is marked, and N+2 after it', () => {
    const n = turn([], [{ slug: 'ui_screen' }, { slug: 'page_get' }]);
    expect(n.usedUi).toBe(true);
    const n1 = turn([n.data], [{ slug: 'page_get' }]);
    expect(n1.usedUi).toBe(true);
    // N has scrolled out of the window the model sees; N+1 still holds it.
    const n2 = turn([n1.data], []);
    expect(n2.usedUi).toBe(true);
  });

  it('a history no window reached leaves the turn unmarked', () => {
    expect(turn([{}, { thoughts: [] }, null], [{ slug: 'page_get' }]).usedUi).toBe(false);
  });

  it("a team reply's used_private counts as the window too", () => {
    expect(turn([{ used_private: true }], []).usedUi).toBe(true);
  });
});
