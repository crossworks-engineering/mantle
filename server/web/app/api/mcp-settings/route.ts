/**
 * Owner-only backing API for Settings → MCP. GET returns the connector's state
 * (enabled flag, the paste-in URL, and the connected clients); PATCH flips the
 * box-level enable flag. Session-gated (not in PUBLIC_PATHS).
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { connectorUrl } from '@/lib/mcp-oauth';
import { listConnectedClients } from '@/lib/mcp-clients';
import { readJson } from '@/lib/read-body';
import { feature } from '@mantle/config';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  PATCH: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

export async function GET() {
  const user = ownerCaller();
  const [prefs, clients] = await Promise.all([
    loadProfilePreferences(user.id),
    listConnectedClients(user.id),
  ]);
  return NextResponse.json({
    enabled: feature('remoteMcp', { prefs }),
    connectorUrl: connectorUrl(),
    clients,
  });
}

export async function PATCH(req: Request) {
  const user = ownerCaller();
  const body = await readJson(req, { refuseEmpty: true });
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }
  await updateProfilePreferences(user.id, { remoteMcpEnabled: enabled });
  return NextResponse.json({ enabled });
}
