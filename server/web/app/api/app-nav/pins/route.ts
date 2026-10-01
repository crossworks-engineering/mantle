import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { APP_PINS_MAX } from '@mantle/client-types/app-nav';
import { getOwnerOr401 } from '@/lib/auth';
import { saveAppPins } from '@mantle/content';

/**
 * PUT /api/app-nav/pins { pins } — replace this LOGIN's pinned apps, in order.
 * Personal, unlike the layout: each person pins what they reach for. Pins of
 * apps that no longer exist are dropped; [] clears them.
 */
const Body = z.object({ pins: z.array(z.string().max(64)).max(APP_PINS_MAX * 2) });

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'pins (array of app ids) required' }, { status: 400 });
  }
  const pins = await saveAppPins(user.id, user.actor.id, parsed.data.pins);
  return NextResponse.json({ pins });
}
