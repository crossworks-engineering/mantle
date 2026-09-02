import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { previewOpenapiSpec } from '@mantle/tools';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

/** The pick step: fetch + parse a spec WITHOUT creating anything and return
 *  its inventory (title, servers, security schemes, tags with counts, and
 *  every operation with its identity) so a selection can be built before the
 *  connector exists. SSRF-guarded and size-capped like the sync's own fetch. */

const Body = z.object({ specUrl: z.string().min(1).max(2000) });

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const preview = await previewOpenapiSpec(parsed.data.specUrl);
    return NextResponse.json({ preview });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 502 });
  }
}
