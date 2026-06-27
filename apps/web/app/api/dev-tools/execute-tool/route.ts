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

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { dispatchTool, resolveTool } from '@mantle/tools';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const Body = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/),
  input: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const tool = await resolveTool(user.id, parsed.data.slug);
  if (!tool) {
    return NextResponse.json(
      { error: `tool '${parsed.data.slug}' not found or disabled` },
      { status: 404 },
    );
  }
  const t0 = performance.now();
  const result = await dispatchTool(tool, parsed.data.input, {
    ownerId: user.id,
    surface: { kind: 'web' },
  });
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
