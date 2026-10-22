/**
 * Who made a run, checked before any of its items runs (defence in depth
 * against a forged run the sweep would execute). The narrow login holds no
 * write of a run (its rows are made at the full-route spot run-control);
 * this is the second wall, in the one place every item runs
 * (executeRunItem and the worker step): a run must name its maker, its
 * planning assistant or the login its planning turn served (run_plan names
 * one, and refuses a delegate that serves none), and a login it names must
 * still exist (its items run as that login as it is now, in its own scope,
 * a disabled or demoted login's run included). A run that fails it never
 * runs as the bare owner or as the system.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { agents, authUsers, db, workspaces } from '@mantle/db';
import type { RunItemFailure } from '@mantle/db';

export async function runMakerRefusal(run: {
  agentId: string | null;
  loginId: string | null;
}): Promise<RunItemFailure | null> {
  if (!run.agentId && !run.loginId) {
    return {
      type: 'no_maker',
      message:
        'this run names neither the assistant that planned it nor the login it serves, so none of its items may run. Plan it again with run_plan from a chat.',
    };
  }
  if (!run.loginId) {
    // No login: the run is the brain owner's own (the anchor's turns name
    // none), so its assistant must be an assistant of the owner's: this
    // brain's, in the Admin workspace or in none (round 12, app LOW-2). A
    // run naming any other assistant and no login would run that
    // assistant's tool groups as the owner.
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .leftJoin(workspaces, eq(workspaces.id, agents.workspaceId))
      .where(
        and(
          eq(agents.id, run.agentId!),
          sql`${agents.ownerId} = "public"."mantle_brain_id"()`,
          or(isNull(agents.workspaceId), eq(workspaces.isAdmin, true)),
        ),
      );
    if (!agent) {
      return {
        type: 'no_maker',
        message:
          "this run names no login and its assistant is not one of the owner's, so none of its items may run. Plan it again with run_plan from a chat.",
      };
    }
    return null;
  }
  const [login] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, run.loginId));
  if (!login) {
    return {
      type: 'login_missing',
      message:
        'the login this run serves is gone, so its items may not run. Plan it again with run_plan from a chat.',
    };
  }
  return null;
}
