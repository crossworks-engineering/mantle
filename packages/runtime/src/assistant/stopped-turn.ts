/**
 * How to record a turn that ended under an abort with NOTHING to show.
 *
 * Such a turn used to finalize 'complete' with a 0-character reply, which left
 * a dead turn indistinguishable from a successful one: no error, no failed
 * status, nothing any failure count or alert would ever pick up. On 2026-09-09
 * a stalled OpenRouter call sat for 3606s (the SDK's one-hour retry envelope,
 * to the second) and then recorded exactly that — twice in one morning — so the
 * only symptom anyone could see was a composer stuck on "Thinking…".
 *
 * The rule is deliberately narrow: a stop that DID stream something keeps its
 * partial reply and still finalizes 'complete', because a partial answer is an
 * answer. Only the empty case is a failure.
 */

/** Name of the abort reason our stream guards raise on a connect/idle timeout;
 *  a user Stop carries an `AbortError` (or no reason at all) instead. */
const TIMEOUT_REASON = 'TimeoutError';

export const STALLED_MESSAGE =
  'The model stalled before sending any output, so the turn timed out.';
export const STOPPED_MESSAGE = 'Stopped before the model sent any output.';

/**
 * The failure message for a turn that stopped without producing output, or
 * `null` when the turn should finalize normally.
 *
 * `signal` is the turn's abort signal (null when the turn isn't cancellable);
 * `reply` is the composed reply after any partial has been folded in.
 */
export function stoppedWithoutOutput(
  signal: AbortSignal | null | undefined,
  reply: string,
): string | null {
  if (!signal?.aborted) return null;
  if (reply.trim()) return null;
  const reason = (signal.reason as { name?: string } | undefined)?.name;
  return reason === TIMEOUT_REASON ? STALLED_MESSAGE : STOPPED_MESSAGE;
}
