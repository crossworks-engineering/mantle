/**
 * Live turn streaming feature flag (server-side).
 *
 * Phase 1–3 of `docs/live-turn-streaming.md` lands behind this so the SSE
 * surface stays dark until a producer is wired — zero behaviour change while
 * unset. Enable with `MANTLE_TURN_STREAMING=1` (any non-empty value). The stream
 * endpoint 404s when off, exactly as if the feature didn't exist.
 */
export function isTurnStreamingEnabled(): boolean {
  return !!process.env.MANTLE_TURN_STREAMING?.trim();
}
