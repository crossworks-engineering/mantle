/**
 * The runner-queue feature gate. DARK BY DEFAULT — a brain opts in with
 * `MANTLE_RUNS=1` (dogfood on dev first; Jason gates each slice release).
 * Opposite polarity from `MANTLE_TURN_STREAMING` (a shipped feature with an
 * off-switch): runs are pre-release, so unset means off.
 *
 * What the gate controls: creating new runs (`run_plan` / `run_append`
 * refuse) and the runs worker's queue handlers + sweep (idle when off).
 * `run_state` / `run_cancel` stay live regardless, so an operator can always
 * inspect or stop what already exists.
 */
export function isRunsEnabled(): boolean {
  const v = process.env.MANTLE_RUNS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}
