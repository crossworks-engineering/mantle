import { NextResponse } from '@/server/http-compat';
import { loadPreferencesFor, logoVersion } from '@mantle/content';
import type { MemberShell } from '@mantle/client-types';
import { getMemberOr401, mintAssetToken } from '@/lib/auth';
import { shellPart } from '@/lib/shell-part';

type Prefs = Awaited<ReturnType<typeof loadPreferencesFor>>;

/**
 * GET /api/member/shell: chrome data for a MEMBER login (member logins,
 * Phase 1). The member twin of /api/shell: who is signed in, the brain's brand
 * (theme, fonts, logo), and a member asset token for the Library's image and
 * file srcs. No brain items here, and nothing admin (no approvals count, no
 * onboarding). The client learns the role from which shell answers, so the
 * preferences reads never fail it (client logins audit A13): a failed one is
 * logged and its part answers unset.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const [brain, personal] = (await Promise.all([
    shellPart('member/shell', 'brand', () => loadPreferencesFor(member.anchorId), {}),
    shellPart('member/shell', 'own preferences', () => loadPreferencesFor(member.loginId), {}),
  ])) as [Prefs, Prefs];
  const body: MemberShell = {
    role: 'member',
    loginId: member.loginId,
    displayName: member.displayName,
    email: member.email,
    avatar: personal.avatarSeed
      ? {
          style: brain.avatarStyle ?? '',
          seed: personal.avatarSeed,
          parts: personal.avatarParts ?? null,
        }
      : null,
    avatarPhotoVersion: logoVersion(personal.avatarPhotoKey),
    // `act` = this member login: the member byte routes re-check it; the admin
    // byte routes refuse it.
    assetToken: await mintAssetToken(member.anchorId, member.loginId),
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
