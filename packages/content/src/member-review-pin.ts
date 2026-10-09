/**
 * The Approve pin (workspace review pattern, security line 3): an Approve
 * carries the `submittedAt` of the version the admin was shown, and the
 * locked accept refuses when the item has another one now (its author
 * recalled it and sent it again). A submitted item is frozen until then, so
 * the time it was sent names the version. Pure, so it is tested alone.
 */

/** Whether the pinned `submittedAt` is the one the item has now. Undefined:
 *  no pin, nothing to compare (the accept route refuses that itself,
 *  `requirePin`). Null matches only an item never submitted (a left-behind
 *  one): a submitted or taken item always has a time, so a null pin fails. */
export function pinHolds(pinned: string | null | undefined, now: string | null): boolean {
  if (pinned === undefined) return true;
  if (pinned === null || now === null) return pinned === now;
  const a = Date.parse(pinned);
  return Number.isFinite(a) && a === Date.parse(now);
}
