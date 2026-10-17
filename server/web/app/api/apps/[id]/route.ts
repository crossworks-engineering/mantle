/**
 * /api/apps/[id] — get (GET), update metadata (PATCH), delete (DELETE).
 * PATCH also sets the informational flag (`dataReadOnly`, client logins C6)
 * and MCP access (`mcpAccess`, team apps Phase 1), and "trust its tools"
 * (`trustTools`, team apps Phase 3): the author ceiling. Those three are an
 * Admin user's only (403 admin-only for a member or a client, W6b fix
 * round 1); a member edits its own app's name and look.
 */
import { NextResponse } from '@/server/http-compat';
import { cappedOne } from '@/lib/list-workspaces';
import { z } from 'zod';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';
import { ownerCaller, ownerCallerWithLogin } from '@/lib/auth';
import { APP_DESCRIPTION_MAX } from '@/lib/app-meta';
import {
  getApp,
  updateAppMeta,
  deleteApp,
  notifyAppNavChanged,
  setAppAuthorLevel,
} from '@mantle/content';
import { assertItemRight } from '@mantle/db';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). Since arch A7 the old `GET
 *  /api/apps/members` (a 410 stub until then) reaches this route as an
 *  [id] of `members`, and answers this 404, not the database's 500. */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const app = await getApp(user.id, id);
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ app: await cappedOne(app) });
}

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  // Emoji or `lucide:<name>`; '' clears. Shape is projected on write.
  icon: z.string().max(APP_ICON_MAX).optional(),
  // A tint key, or null to clear back to the neutral tile.
  color: z.enum(APP_TINTS).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  // '' clears it.
  description: z.string().max(APP_DESCRIPTION_MAX).optional(),
  // Informational (client logins C6): members and clients only read the
  // app's data. This route (admin only) is its one writer. It changes no
  // grant (contract change 36): while it is on nobody beyond Admin writes
  // the data, whatever the grants' Write says; off, the grants decide.
  dataReadOnly: z.boolean().optional(),
  // MCP access (team apps Phase 1, 0234): a member's or client's MCP
  // connection reaches the app's data. This route (admin only) is its one
  // writer: no agent tool and no API key sets it (a key never reaches it).
  mcpAccess: z.boolean().optional(),
  // Trust its tools (team apps Phase 3, M3 audit): true lifts the author
  // ceiling ('admin': the app runs its tools at the runner's own rules),
  // false puts it back ('team'). An admin's own click after reading the
  // declared tools: this route (admin session only) is its one writer, so
  // no agent tool, API key or code edit ever lifts a ceiling.
  trustTools: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The owner and the login's kind: the gate's answer for this request (A6b:
  // the login's row was read again on the system pool before).
  const caller = ownerCallerWithLogin();
  const user = caller.user;
  const { id } = await ctx.params;
  const body = await readBody(req, PatchBody);
  const { name, trustTools, ...rest } = body;
  // The three admin switches (W6b fix round 1, H2): a member or a client
  // edits its own app's name and look here (MEMBER_OPEN_WRITES), never its
  // author ceiling, its MCP access or the informational flag.
  if (
    (trustTools !== undefined || rest.mcpAccess !== undefined || rest.dataReadOnly !== undefined) &&
    caller.kind !== 'admin'
  ) {
    return NextResponse.json(
      {
        error: 'forbidden',
        reason: 'admin-only',
        message: 'Only an Admin user sets trustTools, mcpAccess or dataReadOnly.',
      },
      { status: 403 },
    );
  }
  // The caller's edit of the app first (the pre-check removal part 2: the
  // HTTP gate asked it, in every mode): an app the scope does not read is
  // the mapper's 404, as an id no row has; one it may not edit the 403
  // item-workspace; a read-only copy the copy's words (the database's
  // checks let an app copy's metadata change through, and in warn a
  // reader's edit, an Admin switch's included).
  await assertItemRight(id, 'edit');
  let app = await updateAppMeta(user.id, id, { ...(name ? { title: name } : {}), ...rest });
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  if (trustTools !== undefined) {
    await setAppAuthorLevel(user.id, id, trustTools ? 'admin' : 'team');
    app = (await getApp(user.id, id)) ?? app;
  }
  // The sidebar tree shows name, icon and colour: refresh it everywhere.
  void notifyAppNavChanged(user.id);
  return NextResponse.json({ app });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A delete by a login other than the brain's owner stays in the trash
  // until the owner purges it (CEO decision 1, W6b fix round 1).
  const ok = await deleteApp(user.id, id, {
    deletedBy: { loginId: user.actor.id, owner: user.actor.isOwner },
  });
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  void notifyAppNavChanged(user.id);
  return NextResponse.json({ ok: true });
}
