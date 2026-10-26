/**
 * The one way a circuit drawn from the uploaded P&IDs is made, for every
 * author (DWG bones phase 6, "same check for every author"): an internal
 * agent (Draftsman, Presenter) and a client over MCP read the same steps,
 * from this file: the skills (server/web prompts.ts diagram_design and
 * canvas_authoring), the MCP server instructions (@mantle/mcp-core), and
 * the `next` hints of circuit_trace, circuit_verify, present_create and
 * present_update. The count of guesses no image has checked is the same
 * function for all of them (`imageCheckReport`, over the drawing's own
 * marks: @mantle/diagram-templates imageCheckSummary).
 *
 * Nothing here spends: circuit_verify stays an explicit call on the
 * owner's vision key; a save only reports what is unchecked.
 *
 * Pure text and counts, no I/O, so the prompts module can import it.
 */
import type { PidChecksSummary } from '@mantle/diagram-templates';

/** The server's guard on circuit_verify (verify.ts verifyAgainRefusal):
 *  a second call on a circuit by the same caller at the same revision of
 *  its drawings is refused for `againMinutes` unless `recheck`, and a
 *  recheck at most `perHour` times an hour on a circuit, counting every
 *  call that filed answers. */
export const VERIFY_GUARD = { againMinutes: 10, perHour: 3 } as const;

/** How often circuit_verify runs: one call per trace in a turn, never a
 *  loop over what it left out (each call spends the owner's vision key).
 *  The server holds callers to it (VERIFY_GUARD). */
export const VERIFY_ONCE = `Call \`circuit_verify\` at most once per trace in a turn, never again in the same turn for guesses it left out (not_asked, a cap, a time limit); save the drawing and report how many are unchecked. A second call within ${VERIFY_GUARD.againMinutes} minutes is refused unless \`recheck\`.`;

/** The steps, said the same way to every author. */
export const CIRCUIT_DRAWING_STEPS =
  "A circuit drawn from the uploaded P&IDs is made the same way by every author, an agent here or a client over MCP: 1. `circuit_trace` with the circuit's name; 2. `circuit_verify` on the same circuit: each guess the trace made is asked about on a close-up crop of the drawing by the default vision model, which spends the owner's vision key (a few cents a circuit; dry_run lists the questions for free; it never runs on its own); 3. `circuit_trace` again, so the drawing carries the answers (CHECKED BY IMAGE, or FROM IMAGE where the image named what a guess really is); 4. save that `pid` object, unchanged, with `present_create` (or `present_update` for a saved drawing), once its pid_check is ok. `circuit_trace`, `present_create` and `present_update` report image_check: how many guesses on the drawing no image has checked, and the drawing shows that count until they are. Never drop or relabel a GUESS, CHECKED BY IMAGE or FROM IMAGE mark. " +
  VERIFY_ONCE;

/** circuit_verify's `next`. */
export const VERIFY_NEXT =
  'Call circuit_trace again: it marks these on the drawing (CHECKED BY IMAGE for a yes; FROM IMAGE where a no named what the guess really is; a no without one, or an unsure, stays GUESS). Then save that pid with present_create, or present_update for a drawing already saved. ' +
  VERIFY_ONCE;

/** What a result says about a drawing's image check, or undefined when
 *  nothing on it is a guess the check asks about. */
export function imageCheckReport(
  s: PidChecksSummary | null,
): (PidChecksSummary & { note: string; next?: string }) | undefined {
  if (!s) return undefined;
  const g = (n: number) => `${n} guess${n === 1 ? '' : 'es'}`;
  const done = [
    s.checked ? `${s.checked} checked by image (yes)` : '',
    s.corrected ? `${s.corrected} corrected FROM IMAGE` : '',
    s.contradicted ? `${s.contradicted} contradicted (still a guess)` : '',
    s.unsure ? `${s.unsure} unsure (still a guess)` : '',
  ].filter(Boolean);
  return {
    ...s,
    note: s.unchecked
      ? `${g(s.unchecked)} of ${s.guesses} on this drawing ${s.unchecked === 1 ? 'is' : 'are'} not checked by image${done.length ? `; ${done.join(', ')}` : ''}. The drawing shows "${s.unchecked} not checked by image" until they are.`
      : `Every one of the ${g(s.guesses)} on this drawing has an image check: ${done.join(', ')}. None is certain.`,
    ...(s.unchecked
      ? {
          next: `Check them: circuit_verify on the circuit (spends the owner's vision key; dry_run lists the questions for free), then circuit_trace again and save its pid (present_create, or present_update with the canvas id). Only when asked to skip the check: save as is and say how many guesses are unchecked. ${VERIFY_ONCE}`,
        }
      : {}),
  };
}
