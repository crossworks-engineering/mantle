/**
 * The ui budget of a member's workspace turn (docs/agent-ui.md, "Members"):
 * at most UI_TEAM_MAX_CALLS ui calls and UI_TEAM_MAX_WAIT_MS of waiting on
 * the window in all, per turn. A workspace turn holds a slot of the member
 * turn queue (a few per brain) while each call waits, so a turn that kept
 * asking would hold it for minutes. Past either, a ui tool answers at once
 * with UI_BUDGET_ERROR. An owner turn has no ui budget (its own queue).
 *
 * Per turn id, in the runner's memory: a turn runs in one process, and a
 * delegated child shares its turn id, so it shares the budget. A turn
 * recovered after a restart starts a new count (its calls already made are
 * found again by their step keys, and count again: never more than the
 * cap). An entry no call touched for an hour is dropped.
 */

/** The most ui calls one workspace turn makes. */
export const UI_TEAM_MAX_CALLS = 12;
/** The most time one workspace turn waits on its window, in all, ms. */
export const UI_TEAM_MAX_WAIT_MS = 3 * 60_000;
/** The refusal past either, as the model reads it (its code first). */
export const UI_BUDGET_ERROR =
  'ui_budget: ui budget used for this turn (at most 12 window actions and 3 minutes of waiting on the window per turn). Stop acting in the window: answer in text, and tell the person what is left for them to do there.';

const IDLE_MS = 60 * 60_000;

type Spent = { calls: number; waitedMs: number; touchedAt: number };

/** One budget store (the runner's; a test makes its own). */
export class UiBudget {
  private readonly turns = new Map<string, Spent>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private spent(turnId: string): Spent {
    const t = this.now();
    for (const [id, s] of this.turns) if (t - s.touchedAt > IDLE_MS) this.turns.delete(id);
    let s = this.turns.get(turnId);
    if (!s) {
      s = { calls: 0, waitedMs: 0, touchedAt: t };
      this.turns.set(turnId, s);
    }
    s.touchedAt = t;
    return s;
  }

  /** Take one call of `turnId`'s budget: the wait it may have (ms), or null
   *  when the budget is used (nothing is taken). */
  take(turnId: string): number | null {
    const s = this.spent(turnId);
    const left = UI_TEAM_MAX_WAIT_MS - s.waitedMs;
    if (s.calls >= UI_TEAM_MAX_CALLS || left <= 0) return null;
    s.calls += 1;
    return left;
  }

  /** Count `ms` of waiting on `turnId`'s window. */
  waited(turnId: string, ms: number): void {
    this.spent(turnId).waitedMs += Math.max(0, ms);
  }
}

/** The runner's budget store. */
export const uiTeamBudget = new UiBudget();
