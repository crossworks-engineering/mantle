import { NextResponse } from '@/server/http-compat';
import { loadPreferencesFor, logoVersion } from '@mantle/content';
import type { ClientShell } from '@mantle/client-types';
import { getClientOr401, mintAssetToken } from '@/lib/auth';
import { CLIENT_ASSET_TOKEN_TTL_SECONDS } from '@/lib/auth/tokens';
import { shellPart } from '@/lib/shell-part';
import { READER_TREE_KINDS } from '@mantle/content/tree';

type Prefs = Awaited<ReturnType<typeof loadPreferencesFor>>;

/**
 * GET /api/client/shell: chrome data for a CLIENT login (client logins,
 * Phase C2). The client twin of /api/member/shell: who is signed in, the
 * brain's brand (theme, fonts, logo), and a client asset token for the image
 * and file srcs of "Shared with you". No brain items, no staff names, no
 * avatar. The app learns the role from which shell answers, so the brand
 * read never fails it (client logins audit A13): a failed one is logged and
 * the brand answers unset.
 */
export async function GET() {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const brain = (await shellPart(
    'client/shell',
    'brand',
    () => loadPreferencesFor(client.anchorId),
    {},
  )) as Prefs;
  const body: ClientShell = {
    role: 'client',
    loginId: client.loginId,
    displayName: client.displayName,
    email: client.email,
    // `act` = this client login, signed with its session epoch: the client
    // byte routes re-check both; the admin and member byte routes refuse it.
    // 10 minutes (audit B23): this answer is asked again every 60 s.
    assetToken: await mintAssetToken(client.anchorId, client.loginId, {
      ttlSeconds: CLIENT_ASSET_TOKEN_TTL_SECONDS,
    }),
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
    // The kinds its Library holds, browsed as a read-only folder tree.
    treeKinds: [...READER_TREE_KINDS],
  };
  return NextResponse.json(body);
}
