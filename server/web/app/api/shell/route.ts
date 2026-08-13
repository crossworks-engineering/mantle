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
    ? { style: prefs.avatarStyle ?? '', seed: prefs.avatarSeed }
    : null;
  // Short-lived asset-access token so a detached client's <img>/<iframe>/download
  // srcs (which can't carry a bearer) can load `?raw=1` files + attachments. The
  // client appends it via `assetUrl()`; same-origin ignores it (cookie auth). See
  // lib/asset-url.ts + getOwnerForAsset.
  const assetToken = buildAssetToken(user.id);
  return NextResponse.json({
    onboarded,
    avatar,
    pendingApprovals,
    assetToken,
    siteName: prefs.siteName ?? null,
    peerName: prefs.peerName ?? null,
    colorTheme: prefs.colorTheme ?? null,
    fontLogo: prefs.fontLogo ?? null,
    fontTitle: prefs.fontTitle ?? null,
    fontUi: prefs.fontUi ?? null,
    fontProse: prefs.fontProse ?? null,
    // Brand logo (replaces the wordmark when set) — src is the public
    // /api/appearance/logo, these are the cache-busting versions. The dark
    // variant is optional; renderers fall back dark → base → wordmark.
    logoVersion: logoVersion(prefs.logoKey),
    logoDarkVersion: logoVersion(prefs.logoDarkKey),
  });
}
