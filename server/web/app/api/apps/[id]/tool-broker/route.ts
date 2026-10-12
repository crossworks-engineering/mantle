/**
 * /api/apps/[id]/tool-broker — the host relays a running app's host.tools.call()
 * here. This is /api/dev-tools/execute-tool PLUS a per-app allowlist gate: the
 * slug MUST be declared in the app's manifest.toolSlugs, or we refuse. The tool
 * itself was authored by the toolsmith / API Console; we just dispatch it with
 * the owner's auth so secrets resolve server-side (the iframe never sees a key).
 *
 * The rules come from appToolLevel (client tier audit L1, plan R2), the one
 * rule the member and client brokers share. An app a workspace other than
 * Admin holds gets the team rules on the team role, even when an admin runs
 * it: it reads only what every holder reads, so a tool that read more could
 * copy it into data the other holders read. An app the Admin workspace alone
 * holds runs any declared tool with the owner's auth, as always.
 *
 * The id is bound to the authenticated session + route — an app can only ever
 * broker as itself.
 *
 * A tool that needs the owner's confirmation (apps audit S1) never runs on
 * the app's word alone. The first call answers 409 `reason: 'confirm'` with a
 * ticket for that exact call; the host page shows the owner the tool and its
 * input and, on Yes, sends the call again with `confirmToken`. The app never
 * sees the ticket (the host builds the request body from the slug and input
 * only), so app code cannot confirm for the owner. The member and client
 * brokers refuse such tools outright: nobody there can confirm.
 *
 * Every login since W7e: a member's run goes through lib/app-runner.ts (the
 * team rules, the member broker's, on a team surface naming the login). A
 * client login is refused (403 client-login), never the admin path below.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { memberToolBroker } from '@/lib/app-runner';
import {
  buildAppToolConfirmToken,
  getOwnerOr401WithLogin,
  verifyAppToolConfirmToken,
  type AppToolConfirmClaims,
} from '@/lib/auth';
import { getAppRuntime, recordAppAccess, recordAppError } from '@mantle/content';
import {
  appToolLevel,
  appToolScope,
  appToolVerdict,
  dispatchTool,
  outsideCallLogDetail,
} from '@mantle/tools';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  /** The host's confirmation ticket for this exact call (never the app's). */
  confirmToken: z.string().max(4096).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await getOwnerOr401WithLogin();
  if (got instanceof Response) return got;
  const { id } = await ctx.params;
  // A member's run (W7e): the team rules, never a confirmation.
  if (got.kind === 'member') return memberToolBroker(req, got.member, id);
  const user = got.user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  const app = await getAppRuntime(user.id, id);
  if (!app) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });

  // The author ceiling (team apps Phase 3): a member-built app runs its
  // tools at team rules, an admin's run included. An app a workspace other
  // than Admin holds runs the team rules too (plan R2).
  const level = appToolLevel('admin', app.toolRules, app.authorLevel);
  // The admin's own login rule applies to a client-level app run. A
  // member-built app (team rules by its author) keeps the Team rule: the
  // admin's own connectors (their Admin workspace's Write ticks) must not
  // lift an author-limited app above what it runs with for its members.
  // The admin's test run of a submitted app does the same
  // (apps/members/[id]/test/tool-broker).
  const verdict = await appToolVerdict(
    level,
    user.id,
    app.manifest.toolSlugs ?? [],
    parsed.data.slug,
    level === 'team' ? undefined : user.actor.id,
    level === 'admin' ? undefined : { appId: app.id },
  );
  const logError = (message: string, status: number) =>
    recordAppError({
      ownerId: user.id,
      appNodeId: id,
      actorId: user.actor.id,
      source: 'tool',
      via: 'owner',
      slug: parsed.data.slug,
      message,
      status,
    });
  if (!verdict.ok) {
    logError(verdict.reason, verdict.status);
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  // Below admin rules (a client-level app, or a member-built one), an
  // outside call is logged like a member's: its kind, and a write's input
  // (M2 audit, low 4).
  if (level !== 'admin') {
    recordAppAccess({
      ownerId: user.id,
      appNodeId: id,
      actorId: user.actor.id,
      kind: 'tool',
      detail: {
        via: 'owner',
        slug: parsed.data.slug,
        ...outsideCallLogDetail(verdict, parsed.data.input),
      },
    });
  }

  if (level === 'admin' && verdict.tool.requiresConfirm) {
    const claims: AppToolConfirmClaims = {
      ownerId: user.id,
      actorId: user.actor.id,
      appId: id,
      slug: verdict.tool.slug,
      inputHash: createHash('sha256').update(JSON.stringify(parsed.data.input)).digest('hex'),
    };
    const token = parsed.data.confirmToken;
    if (!token) {
      return NextResponse.json(
        {
          ok: false,
          reason: 'confirm',
          error: `The tool '${verdict.tool.slug}' needs your confirmation before it runs.`,
          confirm: {
            token: buildAppToolConfirmToken(claims),
            slug: verdict.tool.slug,
            name: verdict.tool.name,
            description: verdict.tool.description,
          },
        },
        { status: 409 },
      );
    }
    if (!verifyAppToolConfirmToken(token, claims)) {
      logError('the confirmation expired or did not match the call', 403);
      return NextResponse.json(
        {
          ok: false,
          error: `The confirmation for '${verdict.tool.slug}' expired or does not match this call. Run it again.`,
        },
        { status: 403 },
      );
    }
  }

  const scope = appToolScope(
    level,
    {
      loginId: user.actor.id,
      name: user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'admin',
    },
    { id },
  );
  const result = await withViewer(scope.viewer, scope.actsFor, () =>
    dispatchTool(verdict.tool, parsed.data.input, { ownerId: user.id, surface: scope.surface }),
  );
  if (!result.ok) logError(result.error, 200);
  return NextResponse.json(result);
}
