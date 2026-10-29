import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';
import {
  normalizePersonDescription,
  PERSON_DESCRIPTION_MAX,
  personDescriptionLength,
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
 * how an agent finds "the developer". It is stored as one line of visible
 * text (normalizePersonDescription: newlines and tabs become spaces;
 * control and format characters, such as U+0000, zero-width spaces and
 * bidi overrides, are dropped). null, '' or nothing visible clears it. Over
 * PERSON_DESCRIPTION_MAX code points after that is refused, never cut.
 *
 * The body names the login the text was written as (`loginId`), as the
 * Desk's does: a save for any other login is refused (403, code
 * `login-mismatch`), so a tab left on one login never writes another's
 * card after the browser switched logins.
 *
 * Open to every login (`open: 'any'`, anyLoginCaller), a member as an Admin
 * user: the description is the login's own. A PERSONAL key, written on the
 * login's own profile row only (updateProfilePreferences, the profile-row
 * spot), never the brain's.
 */
const Body = z.object({
  // A generous bound on the payload; the real limit is checked normalized.
  description: z
    .string()
    .max(PERSON_DESCRIPTION_MAX * 4)
    .nullable(),
  // Optional here so a body naming no login is the 403 below, as one
  // naming another is.
  loginId: z.unknown().optional(),
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
  if (parsed.data.loginId !== login.loginId) {
    return NextResponse.json(
      { error: 'loginId is not the login of this session', code: 'login-mismatch' },
      { status: 403 },
    );
  }
  const text = normalizePersonDescription(parsed.data.description ?? '');
  const length = personDescriptionLength(text);
  if (length > PERSON_DESCRIPTION_MAX) {
    return NextResponse.json({ error: personDescriptionTooLongError(length) }, { status: 400 });
  }
  const preferences = await updateProfilePreferences(login.loginId, { description: text });
  return NextResponse.json({ description: projectPersonDescription(preferences.description) });
}
