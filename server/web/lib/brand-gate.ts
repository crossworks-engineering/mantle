import { NextResponse } from '@/server/http-compat';
import { loginHasArea } from '@mantle/db';
import { toolMakerFor } from '@/lib/tools';

/**
 * Why the signed-in login may not change the brain's look, or null (W7
 * integration fix 3, L4). The /api/profile/* brand writers (the colour
 * theme, the fonts, the logo, the avatar style and tint, the backgrounds,
 * the share reader's mode and background) save BRAIN keys: one value for the
 * whole brain, everyone's header and every share link. Like the brand keys
 * of PUT /api/profile, they are the brain owner's (the anchor login, always
 * allowed) or a login's with the settings area. `what` names the setting
 * in the refusal (plan v3 S3 fix round 3: the reminder channel, a brain key
 * on the same rule).
 */
export async function brandSettingsRefusal(
  user: {
    id: string;
    actor: { id: string };
  },
  what = "The brain's look",
): Promise<Response | null> {
  if (!toolMakerFor(user)) return null;
  if (await loginHasArea(user.actor.id, 'settings')) return null;
  return NextResponse.json(
    {
      error: `${what} is changed by the brain owner or a user with the settings area. Ask one of them.`,
    },
    { status: 403 },
  );
}
