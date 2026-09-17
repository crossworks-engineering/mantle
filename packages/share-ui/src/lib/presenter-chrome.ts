/**
 * Which shell a presenter is drawing inside.
 *
 * Every presenter here was written for ONE surface: the anonymous public `/s`
 * page, where the presenter *is* the page. A centred column with a hero title
 * and generous top padding is exactly right there — nothing else is on screen.
 *
 * `/team` then reused the same components inside a master-detail pane, and both
 * of those choices became wrong at once. The pane already draws the title in
 * its own header, so the hero title was the second of three on screen; and the
 * centred cap meant dragging the divider only grew the empty margins while the
 * content stayed a fixed narrow column. Members read that as "the drag is
 * broken". The handle was fine — the content was ignoring it.
 *
 * So a presenter now says which shell it is in:
 *
 * - `'share'` (the default) — the standalone page. Unchanged, and it stays the
 *   default deliberately: the public page must not change because an embedder
 *   forgot a prop.
 * - `'embedded'` — inside a shell that already owns the title and the padding.
 *   Drop the hero title, tighten the vertical rhythm, and let the content take
 *   the width it is given.
 *
 * ⚠ `'embedded'` is NOT a synonym for full-bleed. It means *the shell owns the
 * chrome*; what to do with the width is still the content's call. A table, a
 * file listing and a media viewer all get better as they get wider, so they
 * span the pane. Prose does not — a 2000px line is unreadable no matter whose
 * pane it is in — so a note keeps its measure and simply stops being centred
 * under a title it no longer draws. Anything that reads as "a floating box in
 * the middle of a big screen" is the bug; a comfortable reading measure is not.
 */
export type PresenterChrome = 'share' | 'embedded';

/** Reads better at the call sites than comparing the string in each presenter. */
export function isEmbedded(chrome?: PresenterChrome): boolean {
  return chrome === 'embedded';
}
