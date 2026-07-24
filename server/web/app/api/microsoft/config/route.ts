import { NextResponse } from 'next/server';
import { z } from 'zod';
import { clearConfig, defaultRedirectUri, getConfigStatus, saveConfig } from '@mantle/microsoft';
import { getOwnerOr401 } from '@/lib/auth';
import { requestOrigin } from '@/lib/auth-constants';

/** Current Azure-app config status + the redirect URI to suggest (host-derived). */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  await clearConfig(user.id);
  return NextResponse.json({ status: await getConfigStatus(user.id) });
}
