import { NextResponse } from '@/server/http-compat';
import { loadPreferencesFor, logoVersion } from '@mantle/content';
import type { ClientShell } from '@mantle/client-types';
import { getClientOr401, mintAssetToken } from '@/lib/auth';

/**
 * GET /api/client/shell: chrome data for a CLIENT login (client logins,
 * Phase C2). The client twin of /api/member/shell: who is signed in, the
 * brain's brand (theme, fonts, logo), and a client asset token for the image
 * and file srcs of "Shared with you". No brain items, no staff names, no
 * avatar. The app learns the role from which shell answers.
 */
export async function GET() {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const brain = await loadPreferencesFor(client.anchorId);
  const body: ClientShell = {
    role: 'client',
    loginId: client.loginId,
    displayName: client.displayName,
    email: client.email,
    // `act` = this client login, signed with its session epoch: the client
    // byte routes re-check both; the admin and member byte routes refuse it.
    assetToken: await mintAssetToken(client.anchorId, client.loginId),
    siteName: brain.siteName ?? null,
    colorTheme: brain.colorTheme ?? null,
    fontLogo: brain.fontLogo ?? null,
    fontTitle: brain.fontTitle ?? null,
    fontUi: brain.fontUi ?? null,
    fontProse: brain.fontProse ?? null,
    fontSize: brain.fontSize ?? null,
    fontLogoSize: brain.fontLogoSize ?? null,
    fontTitleSize: brain.fontTitleSize ?? null,
    fontProseSize: brain.fontProseSize ?? null,
    logoVersion: logoVersion(brain.logoKey),
    logoDarkVersion: logoVersion(brain.logoDarkKey),
  };
  return NextResponse.json(body);
}
