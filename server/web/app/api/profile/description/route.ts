import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';
import {
  PERSON_DESCRIPTION_MAX,
  personDescriptionTooLongError,
  projectPersonDescription,
} from '@mantle/client-types/person-description';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PUT: { class: 'self', item: { none: "the login's own things, not an item" } },
});

/**
 * PUT /api/profile/description { description }: who the caller is to the
 * team ("Developer", "Project manager", "Jason's wife"), on its own person
 * card. The card is the team's to read: every login and agent that may see
 * it reads the description (GET /api/people, messenger_directory), which is
 * how an agent finds "the developer". A PERSONAL key, on the caller's own
 * profile row (savePreferencesFor). null or '' clears it. Over
 * PERSON_DESCRIPTION_MAX characters (after trimming) is refused, never cut.
 */
const Body = z.object({
  // A generous bound on the payload; the real limit is checked trimmed.
  description: z
    .string()
    .max(PERSON_DESCRIPTION_MAX * 4)
    .nullable(),
});

export async function PUT(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'description required (text, or null to clear)' },
      { status: 400 },
    );
  }
  const text = (parsed.data.description ?? '').trim();
  if (text.length > PERSON_DESCRIPTION_MAX) {
    return NextResponse.json(
      { error: personDescriptionTooLongError(text.length) },
      { status: 400 },
    );
  }
  const preferences = await savePreferencesFor(user.actor.id, { description: text });
  return NextResponse.json({ description: projectPersonDescription(preferences.description) });
}
