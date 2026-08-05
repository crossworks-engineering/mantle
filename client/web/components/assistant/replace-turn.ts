/**
 * Pure decision + combine logic for the premature-Enter correction flow — a
 * second submit while a turn is still streaming stops the in-flight turn and
 * re-sends original + correction as ONE combined turn (the cancelled pair is
 * stamped `superseded_by` server-side and drops out of prompt history).
 *
 * Kept free of React so the gate is unit-testable: it must be disjoint from
 * today's behaviour everywhere it doesn't apply (blocking mode, attachment
 * turns, missing row ids), where the composer degrades to the old no-op.
 */

export type ReplaceGateInput = {
  /** Client streaming flag (isTurnStreamingEnabledClient). Blocking mode has no
   *  cancel primitive, so the replace path must never engage there. */
  streamingOn: boolean;
  /** A turn is in flight (the composer's `sending`). */
  sending: boolean;
  /** The user already hit Stop — a plain cancel (no supersede) is in flight;
   *  let it finish rather than racing a second cancel. */
  stopping: boolean;
  /** The id the in-flight turn streams under (null before submit / after settle). */
  activeTurnId: string | null;
  /** A file is attached to the CORRECTION being typed. */
  hasAttachment: boolean;
  /** The in-flight turn carried a file. Combining is text-only in v1 — a
   *  re-sent upload would duplicate the file node. */
  lastTurnHadFile: boolean;
};

/** Should a submit-while-sending run the replace path (vs. today's no-op)?
 *  Row-id availability is checked separately (it can arrive late — the caller
 *  retries briefly), so this gate is only the *structural* eligibility. */
export function canReplaceInFlightTurn(g: ReplaceGateInput): boolean {
  return (
    g.streamingOn &&
    g.sending &&
    !g.stopping &&
    g.activeTurnId != null &&
    !g.hasAttachment &&
    !g.lastTurnHadFile
  );
}

/** Combined prompt for the replacement turn: original + newline + correction,
 *  verbatim (v1 — no editing of the original). */
export function combineCorrectedPrompt(original: string, correction: string): string {
  if (!original) return correction;
  if (!correction) return original;
  return `${original}\n${correction}`;
}
