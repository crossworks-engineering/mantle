/**
 * A person's description: who they are to the team, in their own or an
 * admin's words ("Developer", "Project manager", "Jason's wife"). It sits on
 * the person's card next to the name and the status, so it is open to every
 * login and agent that may see that card: the people pickers show it, and an
 * agent reads it in `messenger_directory` to find the right person to
 * message. Free text, never run.
 *
 * Stored as the login's profile key `description` (its own row, like the
 * avatar and the photo); written by the login itself (PUT
 * /api/profile/description) or by the users area (PATCH /api/users/:id).
 */

/** Max characters of a description, measured after trimming. */
export const PERSON_DESCRIPTION_MAX = 500;

/** The 400 message for a description over the limit. */
export function personDescriptionTooLongError(length: number): string {
  return (
    `The description is ${length.toLocaleString('en-US')} characters; the limit is ` +
    `${PERSON_DESCRIPTION_MAX.toLocaleString('en-US')}. Say in a line who this person is ` +
    'to the team: a job title, a role or a relationship.'
  );
}

/** A stored description as the card shows it: trimmed text, or null when
 *  there is none (not a string, empty, or only spaces). */
export function projectPersonDescription(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, PERSON_DESCRIPTION_MAX) : null;
}
