/**
 * Who sees a run on the run surface (/api/runs, /api/runs/:id): a run is
 * the login's it was for (`runs.login_id`), so it shows, and takes a
 * cancel, only to that login; another Admin user with the Settings area
 * sees nothing of it, since a run's items can carry what its login asked
 * and read (a window's text, a private page). A run that names no login
 * (one made before runs carried one, or by the system) shows to the brain
 * owner's login only. The list, the active strip and the worker stats are
 * filtered by the same rule.
 */
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { runs } from '@mantle/db';

/** The signed-in caller the rule reads: the brain, and the login. */
export type RunViewer = { id: string; actor: { id: string } };

/** Whether `viewer` is the brain owner's login (its id is the brain's). */
function ownerLogin(viewer: RunViewer): boolean {
  return viewer.actor.id.toLowerCase() === viewer.id.toLowerCase();
}

/** Whether `viewer` sees the run `run`. */
export function runVisibleTo(run: { loginId: string | null }, viewer: RunViewer): boolean {
  if (run.loginId === null) return ownerLogin(viewer);
  return run.loginId.toLowerCase() === viewer.actor.id.toLowerCase();
}

/** The same rule as a `where` on `runs`, with the brain's own. */
export function runsVisibleWhere(viewer: RunViewer): SQL {
  const mine = eq(runs.loginId, viewer.actor.id);
  return and(
    eq(runs.ownerId, viewer.id),
    ownerLogin(viewer) ? or(mine, isNull(runs.loginId))! : mine,
  )!;
}
