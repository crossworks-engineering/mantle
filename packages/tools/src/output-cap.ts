/**
 * The cap on command output shown to a model.
 *
 * `run_terminal` and `sandbox_exec` are the same tool with different blast
 * radii (one runs on the host, one inside a container), so they share this
 * one capping function. Unlike the string `truncate` helpers, it reports
 * WHETHER it cut, because both callers put that in the tool result so the
 * model knows the output it can see is partial.
 */

/** Per stream, per call. 64 KiB is roughly 16k tokens — already more than a
 *  model should be asked to read, and far past where more helps. */
export const OUTPUT_CAP = 64 * 1024;

/**
 * Cap one stream of command output. `truncated` is the point: a silently cut
 * stdout reads to the model as a complete result, so it concludes from half an
 * answer. The note carries the dropped count so it can decide whether to
 * narrow the command and re-run.
 */
export function capOutput(s: string, cap = OUTPUT_CAP): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, cap)}\n…[truncated ${s.length - cap} chars]`,
    truncated: true,
  };
}
