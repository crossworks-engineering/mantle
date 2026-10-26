import { maxStreamedUploadBytes } from '@mantle/files';
import { NextResponse } from '@/server/http-compat';
import { countPending } from '@mantle/tools';
import { loadPreferencesFor, logoVersion } from '@mantle/content';
import type { Shell } from '@mantle/client-types';
import { anyLoginCaller, sessionRole, mintAssetToken } from '@/lib/auth';
import { adminFacts, type Login } from '@/lib/auth/login';
import { SHORT_ASSET_TOKEN_TTL_SECONDS } from '@/lib/auth/tokens';
import { isOnboarded } from '@/lib/onboarding';
import { shellPart } from '@/lib/shell-part';
import { READER_TREE_KINDS, TREE_LIVE_KINDS } from '@mantle/content/tree';
import { shellFeatures } from '@/lib/features';
import { loginWorkspaces } from '@/lib/login-workspaces';
import { workspaceCaller } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
});

type Prefs = Awaited<ReturnType<typeof loadPreferencesFor>>;

/**
 * GET /api/shell: chrome data for the one (app) shell, for EVERY login (plan
 * 7.1, workspaces W5c): the avatar, the brand, the workspaces switcher, the
 * pending-approvals badge and the onboarding gate. Fetched client-side by
 * `AppShell`, so `(app)/layout.tsx` stays data-free and the same shell loads
 * in a detached client (Electron / DB-less).
 *
 * An admin, a member and a client get ONE shape (`Shell`); `role` says
 * which, and `loginId` is the login at the keyboard. Before W5c a member
 * read /api/member/shell and a client /api/client/shell (both 410 now), and
 * the 200 here meant "admin". What only an admin has answers its empty
 * value for the others: onboarded true, pendingApprovals 0, areas [].
 *
 * The chrome reads never fail the route (client logins audit A13): each is
 * caught and logged, and its part answers empty (the brand as unset, a
 * pending count of 0, no asset token). Onboarding answers true when it
 * cannot be read: a failed read must not send a working admin into the
 * setup wizard. `isOnboarded` is idempotent (it self-stamps an established
 * install), so it's safe in a GET.
 */
async function handleGET(login: Login) {
  const caller = workspaceCaller(login);
  // Whether the login is an Admin user, asked of its scope (adminFacts,
  // plan v3.2 section 2.2): what only an Admin user has answers its empty
  // value for every other login.
  const admin = (await adminFacts(login)).admin;
  const anchorId = caller.anchorId;
  const loginId = caller.loginId;

  // The BRAND (theme, fonts, logo, site name) is the anchor's.
  const read = await shellPart('shell', 'preferences', () => loadPreferencesFor(anchorId), null);
  const prefs: Prefs = read ?? ({} as Prefs);
  const [onboarded, pendingApprovals, ws] = await Promise.all([
    admin && read
      ? shellPart('shell', 'onboarding', () => isOnboarded(login.brainId, read), true)
      : true,
    admin ? shellPart('shell', 'pending count', () => countPending(login.brainId), 0) : 0,
    // The login's workspaces (the switcher) and its Admin areas (W5a), the
    // same builder GET /api/auth/whoami answers with (W7e).
    loginWorkspaces('shell', caller, admin),
  ]);
  // The FACE is per-login: seed, builder pins, the uploaded photo and the
  // starred screens come from the LOGIN's own row (loadPreferencesFor
  // routes brain keys to the anchor regardless), while everything else here
  // (brand, fonts, onboarding) stays on the anchor read above. Same row
  // when the login IS the anchor.
  const personal: Prefs =
    loginId === anchorId
      ? prefs
      : ((await shellPart('shell', 'own preferences', () => loadPreferencesFor(loginId), null)) ??
        ({} as Prefs));
  // Gated on the SEED, which is this login's own, not on the style, which is
  // the brain's: a human opting out to initials is a real choice the profile
  // screen offers, so no seed means initials rather than a default avatar.
  const avatar = personal.avatarSeed
    ? {
        style: prefs.avatarStyle ?? '',
        seed: personal.avatarSeed,
        parts: personal.avatarParts ?? null,
      }
    : null;
  // Short-lived asset-access token so a detached client's <img>/<iframe>/
  // download srcs (which can't carry a bearer) can load bytes. `act` = this
  // login: each byte route re-checks the login's role. Every non-Admin
  // login's lasts 10 minutes: a member's, since
  // its token opens the brain's byte routes in its scope (W7e fix round 1,
  // L3). An Admin user's keeps the two hours.
  const assetToken = await shellPart(
    'shell',
    'asset token',
    async () =>
      mintAssetToken(
        anchorId,
        loginId,
        login.sessionEpoch,
        admin ? {} : { ttlSeconds: SHORT_ASSET_TOKEN_TTL_SECONDS },
      ),
    undefined,
  );
  const { displayName, email } = login;
  const body: Shell = {
    // The display role (sessionRole: from Admin membership).
    role: sessionRole(login),
    loginId,
    // The brain's anchor login (its id is the brain's): the app delete
    // confirm says 30 days for it, "until the owner deletes it" for others.
    isOwner: ws.isOwner,
    onboarded,
    // What this BRAIN can do, for a client on its own release cadence: the
    // client branches on capability rather than on a version number.
    features: shellFeatures(),
    avatar,
    // Uploaded profile PHOTO: outranks the generated avatar in every client
    // (photo, then generated seed, then initials). The sha8 cache-buster for
    // GET /api/profile/photo.
    avatarPhotoVersion: logoVersion(personal.avatarPhotoKey),
    pendingApprovals,
    workspaces: ws.workspaces,
    // Admin areas are an admin's only (loginWorkspaces).
    areas: ws.areas,
    ...(assetToken === undefined ? {} : { assetToken }),
    // The streamed upload cap, so the uploader can refuse an oversized file
    // before sending a byte and say the real number in the message.
    maxUploadBytes: maxStreamedUploadBytes(),
    // Who this browser is signed in AS, for the rail's profile row: the
    // login, not the anchor account.
    displayName: displayName ?? null,
    email: email ?? null,
    // The rail's starred screens: per LOGIN, so they follow the person
    // across browsers. [] when none are starred.
    navFavorites: personal.navFavorites ?? [],
    // The kinds served as the item tree: the admin tree for an admin, the
    // read-only reader tree for a member or a client.
    treeKinds: admin ? [...TREE_LIVE_KINDS] : [...READER_TREE_KINDS],
    siteName: prefs.siteName ?? null,
    peerName: prefs.peerName ?? null,
    colorTheme: prefs.colorTheme ?? null,
    fontLogo: prefs.fontLogo ?? null,
    fontTitle: prefs.fontTitle ?? null,
    fontUi: prefs.fontUi ?? null,
    fontProse: prefs.fontProse ?? null,
    // The sizes travel with the faces: the client adopts both as one choice,
    // since a face reconciled at a stale scale is a half-applied brand.
    fontSize: prefs.fontSize ?? null,
    fontLogoSize: prefs.fontLogoSize ?? null,
    fontTitleSize: prefs.fontTitleSize ?? null,
    fontProseSize: prefs.fontProseSize ?? null,
    // Brand logo (replaces the wordmark when set): src is the public
    // /api/appearance/logo, these are the cache-busting versions. The dark
    // variant is optional; renderers fall back dark, base, wordmark.
    logoVersion: logoVersion(prefs.logoKey),
    logoDarkVersion: logoVersion(prefs.logoDarkKey),
  };
  return NextResponse.json(body);
}

/** The login the pipeline answered (any login; A4 hand batch A). The
 *  handler runs where the request runs, the login's scope for a read (A6b:
 *  the whole body left it by 'rule-in-query' before): the brand and the
 *  login's own preferences by the own-login rule, the pending count and the
 *  private workspace by their definers (0293), the asset token from the
 *  epoch the guard checked. */
export async function GET() {
  const login = anyLoginCaller();
  return handleGET(login);
}
