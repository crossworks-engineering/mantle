/**
 * Wire-contract version for `TurnEvent` (see `@mantle/client-types`). Bump ONLY
 * on a breaking change to an existing event's shape; additive `type`s/fields are
 * non-breaking and don't bump this. The producer stamps it onto every event's
 * `v`; a client may use it to detect a server it's too old to fully understand.
 */
export const TURN_EVENT_SCHEMA_VERSION = 1;

/**
 * The Postgres `NOTIFY` channel that carries live turn events across the
 * apps/api → apps/web process boundary. The runner (apps/api) and the browser's
 * SSE socket (apps/web) are ALWAYS separate processes, so an in-process bus
 * can't bridge them — this channel is the only path (see
 * `docs/live-turn-streaming.md` §0.1). The web realtime bridge LISTENs here.
 *
 * A plain string literal (never an operator-controlled value) — safe to pass to
 * `pg_notify`.
 */
export const TURN_STREAM_CHANNEL = 'turn_stream';
