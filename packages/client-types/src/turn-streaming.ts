/**
 * Live turn streaming feature flags.
 *
 * The feature (SSE status trail + token streaming, see
 * `docs/live-turn-streaming.md`) is **on by default**. It used to be dark-by-
 * default behind `MANTLE_TURN_STREAMING=1`, but that put the on-switch in an
 * env var that has to be set at BUILD time on the client (a `NEXT_PUBLIC_*`
 * inline) — easy to forget, invisible once wrong, and the reason a deployed box
 * could silently show only the static thinking bubble. So the default flipped:
 * the env vars are now an *off* switch (a backup), and a server that wants the
 * feature dark sets `MANTLE_TURN_STREAMING=0`. The stream route 404s when off;
 * the client treats that 404 as a clean fallback (no reconnect loop), so the
 * server stays the single source of truth even though the client flag is baked
 * at build.
 */

/** A flag is ON unless explicitly disabled with 0/false/off/no (case-insensitive).
 *  Unset → on. */
function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Server-side master gate: the SSE/cancel routes exist and the POST turn route
 *  goes non-blocking. Off only when `MANTLE_TURN_STREAMING` is explicitly falsy.
 *  Honours the legacy name `NEXT_PUBLIC_MANTLE_TURN_STREAMING` when the new
 *  one is unset, exactly as `env()` does (@mantle/config ENV_ALIASES): until
 *  A10 #11 this reader ignored it while the replay buffer honoured it, so a
 *  box setting only the legacy name to 0 served the stream routes with no
 *  buffer behind them. The brain reads `feature('turnStreaming')`; this stays
 *  for the published contract. */
export function isTurnStreamingEnabled(): boolean {
  return flagOn(process.env.MANTLE_TURN_STREAMING ?? process.env.NEXT_PUBLIC_MANTLE_TURN_STREAMING);
}

/** Client-side twin, compiled into the browser bundle. Defaults on (an unset
 *  `NEXT_PUBLIC_MANTLE_TURN_STREAMING` → on), so the browser opens the stream;
 *  if the server has it off the GET route 404s and the client falls back
 *  cleanly. Set `NEXT_PUBLIC_MANTLE_TURN_STREAMING=0` at build to compile it
 *  out entirely. */
export function isTurnStreamingEnabledClient(): boolean {
  return flagOn(process.env.NEXT_PUBLIC_MANTLE_TURN_STREAMING);
}
