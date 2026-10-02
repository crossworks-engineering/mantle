import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { recordAppAccess, recordAppError } from '@mantle/content';
import { appToolLevel, appToolScope, appToolVerdict, dispatchTool } from '@mantle/tools';
import { getClientOr401 } from '@/lib/auth';
import { clientAppOr404, clientName } from '@/lib/client-apps';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /api/client/apps/:id/tool-broker: a client's run of an app calls
 * host.tools.call() (client logins C6). Run-only and checked at dispatch
 * time, every call, by the one app level rule the owner and member brokers
 * share (appToolLevel: a client's run of a client app is at client level),
 * which is clientAppToolVerdict: declared by the app, one of the
 * client tools (CLIENT_APP_TOOL_SLUGS: the redacted "Shared with you"
 * reads), a read-only built-in with no confirmation, in an enabled
 * client-level tool group. Then it runs on the CLIENT role, on a client
 * surface that names the login, as the client chat does. Refused calls are
 * logged too.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const gate = rateLimit(`client-tool-broker:${client.loginId}`, { max: 60, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const parsed = Body.safeParse((await readJsonCapped(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const { id } = await ctx.params;
  const app = await clientAppOr404(client.anchorId, id);
  if (app instanceof Response) return app;

  const { slug, input } = parsed.data;
  // clientAppOr404 finds client-level apps only, so this is 'client'.
  const level = appToolLevel('client', 'client');
  const verdict = await appToolVerdict(level, client.anchorId, app.manifest.toolSlugs ?? [], slug);
  recordAppAccess({
    ownerId: client.anchorId,
    appNodeId: app.id,
    actorId: client.loginId,
    kind: 'tool',
    detail: verdict.ok ? { via: 'client', slug } : { via: 'client', slug, refused: verdict.reason },
  });
  const logError = (message: string, status: number) =>
    recordAppError({
      ownerId: client.anchorId,
      appNodeId: app.id,
      actorId: client.loginId,
      source: 'tool',
      via: 'client',
      slug,
      message,
      status,
    });
  if (!verdict.ok) {
    logError(verdict.reason, verdict.status);
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  const scope = appToolScope(level, { loginId: client.loginId, name: clientName(client) });
  const result = await withViewer(scope.viewer, () =>
    dispatchTool(verdict.tool, input, { ownerId: client.anchorId, surface: scope.surface }),
  );
  if (!result.ok) logError(result.error, 200);
  return NextResponse.json(result);
}
