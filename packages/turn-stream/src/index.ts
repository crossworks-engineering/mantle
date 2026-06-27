/**
 * @mantle/turn-stream — the server-side transport for live turn events (status,
 * tool activity, reasoning, token deltas) flowing from the durable runner
 * (apps/api) to the browser's SSE socket (apps/web).
 *
 * The cross-client event SHAPE lives in `@mantle/client-types` (`TurnEvent`,
 * zero-runtime). This package owns the SERVER half: the Postgres `NOTIFY`
 * channel, the schema-version constant the producer stamps, and the publisher.
 * The subscribe half is the web realtime bridge (`apps/web/lib/realtime.ts`).
 *
 * Deliberately low in the dependency graph (only `@mantle/db` +
 * `@mantle/client-types`) so the eventual producer — the tool-loop in
 * `@mantle/agent-runtime` — can import it without an import cycle.
 */

export { TURN_EVENT_SCHEMA_VERSION, TURN_STREAM_CHANNEL, TURN_CANCEL_CHANNEL } from './channel';
export {
  publishTurnEvent,
  publishTurnCancel,
  type TurnStreamEnvelope,
  type TurnCancelEnvelope,
} from './publish';
