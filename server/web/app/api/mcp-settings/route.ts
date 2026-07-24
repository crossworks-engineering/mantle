/**
 * Owner-only backing API for Settings → MCP. GET returns the connector's state
 * (enabled flag, the paste-in URL, and the connected clients); PATCH flips the
 * box-level enable flag. Session-gated (not in PUBLIC_PATHS).
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { connectorUrl } from '@/lib/mcp-oauth';
import { listConnectedClients } from '@/lib/mcp-clients';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [prefs, clients] = await Promise.all([
    loadProfilePreferences(user.id),
    listConnectedClients(user.id),
  ]);
  return NextResponse.json(
    { enabled: prefs.remoteMcpEnabled === true, connectorUrl: connectorUrl(), clients },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function PATCH(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }
  await updateProfilePreferences(user.id, { remoteMcpEnabled: enabled });
  return NextResponse.json({ enabled });
}
