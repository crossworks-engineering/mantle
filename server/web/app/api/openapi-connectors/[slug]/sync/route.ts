import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { syncOpenapiConnector } from '@mantle/tools';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

/** Re-fetch the spec and reconcile the connector's mirrored tools. Explicit
 *  only — sync never runs on a schedule (cost-safety rule). Pass
 *  { overwriteEdited: true } to restore hand-edited rows to the spec version. */

const Body = z.object({ overwriteEdited: z.boolean().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const sync = await syncOpenapiConnector(user.id, slug, {
      overwriteEdited: parsed.data.overwriteEdited,
    });
    return NextResponse.json({ sync });
  } catch (err) {
    const msg = errorMessage(err);
    const status = msg.includes('not an OpenAPI connector') ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
