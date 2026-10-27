/**
 * The one way a circuit drawn from the uploaded P&IDs is made, for every
 * author (DWG bones phase 6, "same check for every author"): an internal
 * agent (Draftsman, Presenter) and a client over MCP read the same steps,
 * from this file: the skills (server/web prompts.ts diagram_design and
 * canvas_authoring), circuit_trace's result (`workflow`, which a client
 * over MCP reads; the MCP server instructions, loaded on every connection,
 * carry only CIRCUIT_STEPS_POINTER to it), and the `next` hints of
 * circuit_trace and circuit_verify.
 *
 * The drawing is plain data: circuit_trace writes the plain words (GUESS,
 * CHECKED BY IMAGE, IMAGE: NO, FROM IMAGE); nothing seals, counts or
 * rewrites them on a save. The proof stays in the brain (the drawing
 * table's sealed Checks tab), and the app shows an overview of it beside a
 * saved drawing (the present checks route). An image check is a help, not
 * a guarantee: engineers verify on the drawing.
 *
 * Nothing here spends: circuit_verify stays an explicit call on the
 * owner's vision key.
 *
 * Pure text, no I/O, so the prompts module can import it.
 */

/** The one line said wherever the image check is shown or explained (the
 *  app's check overview, the skills, the docs). */
export const IMAGE_CHECK_NOTE =
  'Image checks help; they are not a guarantee. Verify on the drawing.';

/** The server's guard on circuit_verify (verify.ts verifyAgainRefusal):
 *  a second call on a circuit by the same caller at the same revision of
 *  its drawings is refused for `againMinutes` unless `recheck`, and a
 *  recheck at most `perHour` times an hour on a circuit, counting every
 *  call that filed answers. It protects the owner's money, nothing else. */
export const VERIFY_GUARD = { againMinutes: 10, perHour: 3 } as const;

/** How often circuit_verify runs: one call per trace in a turn, never a
 *  loop over what it left out (each call spends the owner's vision key).
 *  The server holds callers to it (VERIFY_GUARD). */
export const VERIFY_ONCE = `Call \`circuit_verify\` at most once per trace in a turn, never again in the same turn for guesses it left out (not_asked, a cap, a time limit); save the drawing and say how many are unchecked. A second call within ${VERIFY_GUARD.againMinutes} minutes is refused unless \`recheck\`.`;

/** The steps, said the same way to every author. */
export const CIRCUIT_DRAWING_STEPS =
  "A circuit drawn from the uploaded P&IDs is made the same way by every author, an agent here or a client over MCP: 1. `circuit_trace` with the circuit's name; 2. `circuit_verify` on the same circuit: each guess the trace made is asked about on a close-up crop of the drawing by the default vision model, which spends the owner's vision key (a few cents a circuit; dry_run lists the questions for free; it never runs on its own); 3. `circuit_trace` again, so the drawing carries the answers in plain words (CHECKED BY IMAGE; FROM IMAGE where the image named what a guess really is; IMAGE: NO); 4. save that `pid` object, unchanged, with `present_create` (or `present_update` for a saved drawing), once its pid_check is ok. Only circuit_trace writes GUESS, CHECKED BY IMAGE, IMAGE: NO and FROM IMAGE: never type them yourself, never drop or reword them. The answers, crops and models stay in the drawing table's Checks tab, and the app shows an overview of them beside the saved drawing. " +
  IMAGE_CHECK_NOTE +
  ' ' +
  VERIFY_ONCE;

/** What the MCP server instructions say of it (loaded by every client on
 *  every connection, so a pointer, not the steps): circuit_trace's result
 *  carries the steps (`workflow`: CIRCUIT_DRAWING_STEPS) and its `next`. */
export const CIRCUIT_STEPS_POINTER =
  'A circuit drawn from the uploaded P&IDs: call `circuit_trace` first and follow the steps its result carries (`workflow`, `next`): `circuit_verify` at most once per trace in a turn, `circuit_trace` again, then save that `pid` unchanged.';

/** circuit_verify's `next`. */
export const VERIFY_NEXT =
  'Call circuit_trace again: it writes these on the drawing in plain words (CHECKED BY IMAGE for a yes; FROM IMAGE where a no named what the guess really is; a no without one says IMAGE: NO and stays a guess, an unsure stays GUESS). Then save that pid with present_create, or present_update for a drawing already saved. ' +
  VERIFY_ONCE;
