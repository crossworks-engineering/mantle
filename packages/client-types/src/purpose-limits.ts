/**
 * The size ceiling on the brain's purpose (`preferences.purpose`), shared by
 * the onboarding wizard, Settings → Profile, the routes that save it, and the
 * identity block that injects it into every turn.
 *
 * It used to be three private copies of `600`, and both routes silently
 * `.slice()`d anything longer. On 2026-09-28 a user pasted a 3,888-character
 * assistant persona prompt into the onboarding purpose box: 3,288 characters
 * vanished without a word and the assistant kept its default personality. The
 * routes now refuse an over-long purpose with a 400 and this message, and the
 * UI counts against the same number.
 */

/** Max characters of the brain's purpose, measured AFTER trimming. */
export const PURPOSE_MAX_CHARS = 600;

/** The 400 message for a purpose over the limit. */
export function purposeTooLongError(length: number): string {
  return (
    `The purpose is ${length.toLocaleString('en-US')} characters; the limit is ` +
    `${PURPOSE_MAX_CHARS.toLocaleString('en-US')}. Keep it to one or two sentences on what ` +
    'this brain is for. The assistant’s personality is set in Agent Studio or ' +
    'Settings → Agents, not here.'
  );
}
