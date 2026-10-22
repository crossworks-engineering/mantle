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
import { eq } from 'drizzle-orm';
import { agents, authUsers, db } from '@mantle/db';
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
    // No login: the items run as the owner. Only an assistant that serves
    // no login may make such a run (the owner's own); an assistant assigned
    // to a login plans for that login (run_plan names it), so a run of its
    // that names none would run its items above that login. A gone
    // assistant is execute-item's agent_missing, an assistant outside Admin
    // its below_admin: both answer as before.
    const [agent] = await db
      .select({ assignedUserId: agents.assignedUserId })
      .from(agents)
      .where(eq(agents.id, run.agentId!));
    if (agent?.assignedUserId) {
      return {
        type: 'no_maker',
        message:
          "this run names an assistant that serves a login but not that login, so none of its items may run. Plan it again with run_plan from that login's chat.",
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
