import { NextResponse } from '@/server/http-compat';
import { adminFacts } from '@/lib/auth/login';
import { ownerUserLogin, type SessionUser } from '@/lib/auth/session';
import { toolMakerFor } from '@/lib/tools';

/**
 * Why the signed-in login may not change the brain's look, or null. The
 * /api/profile brand writers (the site name, the peer name and the avatar
 * style of PUT /api/profile, the colour theme, the fonts, the logo, the
 * avatar style and tint, the backgrounds, the share reader's mode and
 * background) save BRAIN keys: one value for the whole brain, everyone's
 * header and every share link. They are the brain owner's (the anchor
 * login, always allowed) or a login's with the users area (every Admin
 * user: branding stays with Admin, not System), as its scope answers it
 * (adminFacts). `what` names the setting in the refusal. The reminder
 * channel is a brain key on the settings area (System): it passes `area`.
 */
export async function brandSettingsRefusal(
  user: SessionUser,
  what = "The brain's look",
  area: 'users' | 'settings' = 'users',
): Promise<Response | null> {
  if (!toolMakerFor(user)) return null;
  const login = ownerUserLogin(user);
  if (login && (await adminFacts(login)).areas.has(area)) return null;
  const who = area === 'users' ? 'an Admin user' : 'a user with the settings area';
  return NextResponse.json(
    { error: `${what} is changed by the brain owner or ${who}. Ask one of them.` },
    { status: 403 },
  );
}
