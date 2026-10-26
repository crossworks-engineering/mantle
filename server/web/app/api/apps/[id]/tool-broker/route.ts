/**
 * /api/apps/[id]/tool-broker: the host relays a running app's
 * host.tools.call() here. A config of the one app tool broker
 * (lib/app-tool-broker.ts runAppToolBroker, A10 #9), which parses the call,
 * judges it, asks the owner to confirm a tool that needs it, dispatches it
 * through the one gate and logs it.
 *
 * An Admin user runs the app at the rules its holders and author allow
 * (appToolLevel): an app the Admin workspace alone holds runs any declared
 * tool with the owner's auth, so secrets resolve server-side and the iframe
 * never sees a key; an app another workspace holds, or a member built,
 * runs the team rules for the admin too (plan R2). The id is bound to the
 * authenticated session and the route: an app can only ever broker as
 * itself.
 *
 * Every login since W7e: a member's run goes through lib/app-runner.ts
 * memberToolBroker (the team rules, the same broker). A client login is
 * refused (403 client-login) by the gate.
 */
import { ownerLoginCaller } from '@/lib/auth';
import { adminFacts } from '@/lib/auth/login';
import { memberToolBroker } from '@/lib/app-runner';
import { runAppToolBroker } from '@/lib/app-tool-broker';
import { getAppRuntime } from '@mantle/content';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    makesItems: false,
    item: { param: 'id', need: 'read' },
    limits: { rateLimit: ['memberToolBroker'] },
  },
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const { id } = await ctx.params;
  // A run by a login that is not an Admin user (adminFacts, asked of its
  // scope): the team rules, never a confirmation.
  if (!(await adminFacts(login)).admin) return memberToolBroker(req, login, id);
  const user = { id: login.brainId, actor: login.actor };
  return runAppToolBroker(req, {
    via: 'owner',
    ownerId: user.id,
    runner: {
      loginId: user.actor.id,
      name: user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'admin',
    },
    app: () => getAppRuntime(user.id, id),
  });
}
