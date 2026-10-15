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
import { ownerCallerWithLogin } from '@/lib/auth';
import { memberToolBroker } from '@/lib/app-runner';
import { runAppToolBroker } from '@/lib/app-tool-broker';
import { getAppRuntime } from '@mantle/content';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = ownerCallerWithLogin();
  const { id } = await ctx.params;
  // A member's run (W7e): the team rules, never a confirmation.
  if (got.kind === 'member') return memberToolBroker(req, got.member, id);
  const user = got.user;
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
