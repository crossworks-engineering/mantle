/**
 * The size ceiling on one assistant turn's text, shared by the composer and the
 * route that validates it.
 *
 * It used to live only in the route's zod schema. The composer had no idea it
 * existed, so pasting a long plan cleared the box, dropped the message from the
 * transcript, and surfaced zod's own words — "Too big: expected string to have
 * <=20000 characters" — in 10px type beside the composer. From the user's seat a
 * message simply vanished, and since a rejected turn writes NOTHING to
 * `assistant_messages`, the whole failure was invisible server-side too. Both
 * ends now read the same number, and the composer offloads rather than fails.
 */

/** Max characters accepted for one turn's `text` — INCLUDING the context
 *  preamble and focus directive the composer appends, which is what the route
 *  actually measures. */
export const ASSISTANT_TURN_MAX_CHARS = 20_000;

/** Longest title the notes API accepts (`POST /api/notes`). */
const NOTE_TITLE_MAX = 200;

/**
 * A note title for an offloaded over-long message: its first non-empty line,
 * trimmed of markdown heading/quote/list punctuation so the title reads as
 * prose. Falls back to a generic label when the body opens with no usable line
 * (a bare code fence, say).
 */
export function longMessageNoteTitle(body: string, fallback = 'Long message'): string {
  for (const raw of body.split('\n')) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, '') // heading
      .replace(/^[>*+-]\s+/, '') // quote / bullet
      .replace(/^\d+[.)]\s+/, '') // ordered item
      .replace(/^```.*$/, '') // fence opener
      .trim();
    if (!line) continue;
    return line.length > NOTE_TITLE_MAX ? `${line.slice(0, NOTE_TITLE_MAX - 1)}…` : line;
  }
  return fallback;
}
