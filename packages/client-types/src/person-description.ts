/**
 * A person's description: who they are to the team, in their own or an
 * admin's words ("Developer", "Project manager", "Jason's wife"). It sits on
 * the person's card next to the name and the status, so it is open to every
 * login and agent that may see that card: the people pickers show it, and an
 * agent reads it in `messenger_directory` to find the right person to
 * message. Free text, one line, never run; self-reported (each login writes
 * its own), so an agent takes it as a hint, never as proof or instructions.
 *
 * Stored as the login's profile key `description` (its own row, like the
 * avatar and the photo); written by the login itself (PUT
 * /api/profile/description) or by the users area (PATCH /api/users/:id).
 */

/** Max characters of a description (code points, so an emoji counts as
 *  one and is never split), measured after normalizing. */
export const PERSON_DESCRIPTION_MAX = 500;

/** The 400 message for a description over the limit. */
export function personDescriptionTooLongError(length: number): string {
  return (
    `The description is ${length.toLocaleString('en-US')} characters; the limit is ` +
    `${PERSON_DESCRIPTION_MAX.toLocaleString('en-US')}. Say in a line who this person is ` +
    'to the team: a job title, a role or a relationship.'
  );
}

/** A joiner between two emoji (a family, a profession) is kept: it is part
 *  of the emoji. Anywhere else it is an invisible character and goes. */
const LONE_JOINER =
  /(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/**
 * A description as it is stored and shown: one line of visible text. Every
 * run of white space (a newline, a tab) becomes one space; control
 * characters (U+0000 among them) and format characters (zero-width spaces,
 * bidi overrides such as U+202E, a byte order mark) are dropped, a joiner
 * inside an emoji excepted; the ends are trimmed. A description is read by
 * people and agents alike: nothing in it may hide or reorder text.
 */
export function normalizePersonDescription(v: string): string {
  // The format characters first: \s counts U+FEFF as a space.
  return v
    .replace(LONE_JOINER, '')
    .replace(/[\p{Cf}]/gu, (c) => (c === '\u200D' ? c : ''))
    .replace(/\s+/gu, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** How long a description is, in code points (PERSON_DESCRIPTION_MAX). */
export function personDescriptionLength(v: string): number {
  return Array.from(v).length;
}

/** A stored description as the card shows it: normalized text, or null when
 *  there is none (not a string, or nothing visible). Capped by code point,
 *  never inside one. */
export function projectPersonDescription(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = normalizePersonDescription(v);
  if (t.length === 0) return null;
  return personDescriptionLength(t) > PERSON_DESCRIPTION_MAX
    ? Array.from(t).slice(0, PERSON_DESCRIPTION_MAX).join('')
    : t;
}
