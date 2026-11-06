/**
 * One window-driving turn per login (docs/agent-ui.md, "The turn names its
 * window"): while a login's turn may use the ui tools, another turn of that
 * login runs with no window, so its ui tools are not offered and it never
 * holds a member queue slot waiting on a window. The seat is taken when a
 * turn's window is decided (run-turn.ts, run-team-turn.ts) and given back at
 * its end, on every path (end.ts endTurnUiCalls).
 *
 * In the runner's memory: a turn runs in one process. The same turn taking
 * its seat again (a DBOS re-run) keeps it. An entry no turn touched for an
 * hour is dropped, so a turn that never reached its end frees the login.
 */

const IDLE_MS = 60 * 60_000;

/** One seat store (the runner's; a test makes its own). */
export class UiWindowSeats {
  private readonly held = new Map<string, { turnId: string; at: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Take `loginId`'s seat for `turnId`: true when it is free or this
   *  turn's already, false while another turn holds it. */
  take(loginId: string, turnId: string): boolean {
    const t = this.now();
    const key = loginId.toLowerCase();
    const had = this.held.get(key);
    if (had && had.turnId !== turnId && t - had.at <= IDLE_MS) return false;
    this.held.set(key, { turnId, at: t });
    return true;
  }

  /** Give the seat back, when `turnId` holds it. */
  release(loginId: string, turnId: string): void {
    const key = loginId.toLowerCase();
    if (this.held.get(key)?.turnId === turnId) this.held.delete(key);
  }
}

/** The runner's seats. */
export const uiWindowSeats = new UiWindowSeats();
