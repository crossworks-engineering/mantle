import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { syncMcpConnector } from '@mantle/tools';
import { errorMessage } from '@mantle/std';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** Re-list the remote server's tools and reconcile the connector's rows.
 *  Explicit only — sync never runs on a schedule (cost-safety rule). */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = ownerCaller();
  const { slug } = await params;
  try {
    const sync = await syncMcpConnector(user.id, slug);
    return NextResponse.json({ sync });
  } catch (err) {
    const msg = errorMessage(err);
    const status = msg.includes('not an MCP connector') ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
