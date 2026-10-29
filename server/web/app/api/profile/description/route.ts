import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';
import {
  PERSON_DESCRIPTION_MAX,
  personDescriptionTooLongError,
  projectPersonDescription,
} from '@mantle/client-types/person-description';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PUT: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
  },
});

/**
 * PUT /api/profile/description { description }: who the caller is to the
 * team ("Developer", "Project manager", "Jason's wife"), on its own person
 * card. The card is the team's to read: every login and agent that may see
 * it reads the description (GET /api/people, messenger_directory), which is
 * how an agent finds "the developer". null or '' clears it. Over
 * PERSON_DESCRIPTION_MAX characters (after trimming) is refused, never cut.
 *
 * Open to every login (`open: 'any'`, anyLoginCaller), a member as an Admin
 * user: the description is the login's own. A PERSONAL key, written on the
 * login's own profile row only (updateProfilePreferences, the profile-row
 * spot), never the brain's.
 */
const Body = z.object({
  // A generous bound on the payload; the real limit is checked trimmed.
  description: z
    .string()
    .max(PERSON_DESCRIPTION_MAX * 4)
    .nullable(),
});

export async function PUT(req: Request) {
  const login = anyLoginCaller();
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
  const preferences = await updateProfilePreferences(login.loginId, { description: text });
  return NextResponse.json({ description: projectPersonDescription(preferences.description) });
}
