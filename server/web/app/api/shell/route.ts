import { NextResponse } from '@/server/http-compat';
import { countPending } from '@mantle/tools';
import { loadPreferencesFor, logoVersion } from '@mantle/content';
import { buildAssetToken, getOwnerOr401 } from '@/lib/auth';
import { isOnboarded } from '@/lib/onboarding';

/**
 * Chrome data for the (app) shell — the avatar, the pending-approvals badge
 * count, and the onboarding gate — fetched client-side by `AppShell` so the
 * `(app)/layout.tsx` itself stays data-free (auth + collapse cookies only) and
 * the same shell is loadable by a detached client (Electron / DB-less). The
 * three reads that used to run in-process during layout render now live behind
 * this one HTTP round-trip. `isOnboarded` is idempotent (it self-stamps an
 * established install), so it's safe in a GET.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const prefs = await loadPreferencesFor(user.id);
  const [onboarded, pendingApprovals] = await Promise.all([
    isOnboarded(user.id, prefs),
    countPending(user.id),
  ]);
  // Gated on the SEED, which is this user's own, not on the style, which is the
  // brain's. It used to gate on the style back when that was personal too, and
  // moving the style to brain level broke both directions of this: with a style
  // set on the brain, a user who chose "use initials instead" still got an
  // avatar (their opt-out did nothing); with no style ever set, NO user got one
  // even though the default style exists and every agent renders in it.
  //
  // The seed is the honest test of "has this person chosen an avatar" — unlike
  // an agent, a human opting out to initials is a real choice the profile
  // screen offers, so absence here means initials rather than a default seed.
  const avatar = prefs.avatarSeed
    ? { style: prefs.avatarStyle ?? '', seed: prefs.avatarSeed, parts: prefs.avatarParts ?? null }
    : null;
  // Uploaded profile PHOTO — outranks the generated avatar in every client
  // (photo → generated seed → initials), and is independent of the seed gate
  // above: a photo works for someone who never rolled a generated avatar.
  // The version is the sha8 cache-buster for GET /api/profile/photo.
  const avatarPhotoVersion = logoVersion(prefs.avatarPhotoKey);
  // Short-lived asset-access token so a detached client's <img>/<iframe>/download
  // srcs (which can't carry a bearer) can load `?raw=1` files + attachments. The
  // client appends it via `assetUrl()`; same-origin ignores it (cookie auth). See
  // lib/asset-url.ts + getOwnerForAsset.
  const assetToken = buildAssetToken(user.id);
  return NextResponse.json({
    onboarded,
    avatar,
    avatarPhotoVersion,
    pendingApprovals,
    assetToken,
    // Who this browser is signed in AS, for the rail's profile row. The ACTOR,
    // not the anchor account: additional logins are ways into the one brain
    // rather than tenants, and the actor is what the audit trail records — so
    // this names the person at the keyboard even on a shared brain. Name first,
    // email as the fallback and as the menu's secondary line.
    displayName: user.actor.displayName ?? null,
    email: user.actor.email ?? null,
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
    // Brand logo (replaces the wordmark when set) — src is the public
    // /api/appearance/logo, these are the cache-busting versions. The dark
    // variant is optional; renderers fall back dark → base → wordmark.
    logoVersion: logoVersion(prefs.logoKey),
    logoDarkVersion: logoVersion(prefs.logoDarkKey),
  });
}
