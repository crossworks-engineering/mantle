import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  clearConfig,
  defaultRedirectUri,
  getConfigStatus,
  saveConfig,
} from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/** App origin from the request, so the suggested redirect URI matches the host
 *  the user actually reaches Mantle on. Mirrors the old page server logic. */
function requestOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Current Azure-app config status + the redirect URI to suggest (host-derived). */
export async function GET(req: Request) {
  const user = await requireOwner();
  const status = await getConfigStatus(user.id);
  return NextResponse.json({
    status,
    suggestedRedirectUri: defaultRedirectUri(requestOrigin(req)),
  });
}

const SaveBody = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  // Blank/omitted on edit = keep the stored secret.
  clientSecret: z.string().optional(),
  tenant: z.string().min(1).default('common'),
  redirectUri: z.string().url('Redirect URI must be an absolute URL'),
});

/** Save (or override) the brain's Azure AD app config from the UI. */
export async function PUT(req: Request) {
  const user = await requireOwner();
  const parsed = SaveBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }
  const saved = await saveConfig(user.id, {
    clientId: parsed.data.clientId,
    clientSecret: parsed.data.clientSecret || undefined,
    tenant: parsed.data.tenant,
    redirectUri: parsed.data.redirectUri,
  });
  if (!saved) {
    return NextResponse.json(
      { error: 'Client secret is required the first time you save.' },
      { status: 400 },
    );
  }
  return NextResponse.json({ status: await getConfigStatus(user.id) });
}

/** Remove the UI config, reverting to environment variables (if any). */
export async function DELETE() {
  const user = await requireOwner();
  await clearConfig(user.id);
  return NextResponse.json({ status: await getConfigStatus(user.id) });
}
