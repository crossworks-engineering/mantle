import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { SoundPreference } from '@mantle/client-types';
import { anyLoginCaller } from '@/lib/auth';
import { loadPreferencesFor, savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
  PUT: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
  },
});

/**
 * The login's UI sounds (on/off and a volume), on its own profile row so the
 * choice follows the person across browsers and devices. The client plays
 * the sounds; the brain only keeps the choice.
 *
 *   GET -> 200 { sounds }   null until the login first saves one (the
 *                           client's default applies)
 *   PUT { sounds: { enabled, volume }, loginId }
 *       -> 200 { sounds }   the stored value (volume clamped to 0..1)
 *       -> 403 { error, code: 'login-mismatch' }   when `loginId` is not the
 *                                                  login of this session
 *       -> 400              anything else
 *
 * The body names the login the choice was made as (`loginId`), as the
 * Desk's does: a save for any other login is refused (403, code
 * `login-mismatch`), so a tab left on one login never writes another's
 * sounds after the browser switched logins.
 *
 * Personal, never a brain-level key: two logins choose freely. Open to every
 * login (`open: 'any'`, anyLoginCaller), a member as an Admin user, as the
 * Desk is: both run in the login's scope, where the profile rules hold it to
 * its own row (mantle_profile_writable, 0302, on write).
 */
export async function GET() {
  const login = anyLoginCaller();
  const prefs = await loadPreferencesFor(login.loginId);
  const sounds: SoundPreference | null = prefs.sounds ?? null;
  return NextResponse.json({ sounds });
}

const Body = z.object({
  sounds: z.object({ enabled: z.boolean(), volume: z.number().finite() }),
  // Optional here so a body naming no login is the 403 below, as one
  // naming another is.
  loginId: z.unknown().optional(),
});

export async function PUT(req: Request) {
  const login = anyLoginCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'sounds ({ enabled: boolean, volume: number }) required' },
      { status: 400 },
    );
  }
  if (parsed.data.loginId !== login.loginId) {
    return NextResponse.json(
      { error: 'loginId is not the login of this session', code: 'login-mismatch' },
      { status: 403 },
    );
  }
  const preferences = await savePreferencesFor(login.loginId, { sounds: parsed.data.sounds });
  const sounds: SoundPreference | null = preferences.sounds ?? null;
  return NextResponse.json({ sounds });
}
