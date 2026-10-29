/**
 * API Console → agent-tool executor. Runs a `tools` table row through the
 * SAME dispatcher the agent tool-loop uses (dispatchTool), so a console
 * test exercises exactly what an agent call would — templating, secret
 * resolution, timeouts, everything.
 *
 * requiresConfirm is intentionally NOT enqueued here: the operator pressing
 * "Run" in the console IS the confirmation. Builtins whose handlers only
 * register inside the agent process return a clear "not registered in this
 * process" error from the dispatcher rather than failing silently.
 */

import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { dispatchTool, ownerWebCaller, resolveTool } from '@mantle/tools';
import { ownerCaller } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { onFullSystemRoute } from '@mantle/db';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

const Body = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/),
  input: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const tool = await resolveTool(user.id, parsed.data.slug);
  if (!tool) {
    return NextResponse.json(
      { error: `tool '${parsed.data.slug}' not found or disabled` },
      { status: 404 },
    );
  }
  const t0 = performance.now();
  // The tool runs as the area's system actor: on the full route from the
  // narrow exit (viewer.ts FULL_ROUTE_SPOTS 'console-tool').
  const result = await onFullSystemRoute('console-tool', () =>
    dispatchTool(tool, parsed.data.input, {
      ownerId: user.id,
      // The signed-in login: a tool that checks the
      // caller (a link) sees it.
      surface: { kind: 'web', loginId: user.actor.id },
      // Through the one gate as the owner's own web call.
      caller: ownerWebCaller(),
    }),
  );
  const durationMs = Math.round(performance.now() - t0);
  if (result.ok) {
    // Artifacts (audio/image bytes) are trimmed to metadata — the console
    // shows what was produced without shipping megabytes of base64.
    const artifacts = (result.artifacts ?? []).map((a) => ({
      kind: a.kind,
      mimeType: a.mimeType,
      caption: a.caption,
      nodeId: a.nodeId,
      producedBy: a.producedBy,
    }));
    return NextResponse.json({ ok: true, output: result.output, artifacts, durationMs });
  }
  return NextResponse.json({ ok: false, error: result.error, durationMs });
}
