import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { syncMcpConnector } from '@mantle/tools';

/** Re-list the remote server's tools and reconcile the connector's rows.
 *  Explicit only — sync never runs on a schedule (cost-safety rule). */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  try {
    const sync = await syncMcpConnector(user.id, slug);
    return NextResponse.json({ sync });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not an MCP connector') ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
