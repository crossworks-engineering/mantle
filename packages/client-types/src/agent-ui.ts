/**
 * The agent UI channel: an in-app agent drives the window the person chats
 * from (docs/agent-ui.md). The wire constants both halves read, in one leaf
 * module: browser-safe and dependency-free, as profile-flags.ts is.
 *
 * The turn names its window (`windowId` on POST /api/assistant/turn); a ui_*
 * tool call reaches that window as a `ui-call` turn event (TurnUiCallData,
 * dto/turns.ts); the window answers POST
 * /api/assistant/turn/:turnId/ui/:callId with `{ windowId, result }`.
 */

/** A window id: fresh per page load, kept in memory by the client. */
export const AGENT_UI_WINDOW_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether `v` is a window id the brain takes. */
export function isAgentUiWindowId(v: unknown): v is string {
  return typeof v === 'string' && AGENT_UI_WINDOW_ID_RE.test(v);
}

/** The header every request a page makes during an agent action carries,
 *  unless the person allowed that request in the window's prompt. The brain
 *  refuses a non-GET carrying it to a route that deletes, sends, shares,
 *  publishes or changes a setting (403 `{ error: 'needs_user' }`). */
export const AGENT_CALL_HEADER = 'x-mantle-agent-call';

/** How long the window has to answer one call, ms (the row's expires_at). */
export const AGENT_UI_CALL_TTL_MS = 15_000;

/** The largest result the window may answer with: its JSON, in bytes. */
export const AGENT_UI_RESULT_MAX_BYTES = 64 * 1024;

/** The actions a ui tool asks of the window (the tool is `ui_<action>`). */
export const AGENT_UI_ACTIONS = [
  'screen',
  'navigate',
  'click',
  'type',
  'select',
  'point',
  'wait',
] as const;
export type AgentUiAction = (typeof AGENT_UI_ACTIONS)[number];

/** What a failed action says, the window's or the brain's own
 *  (`window_gone`: no answer before the call expired; `stopped`: the person
 *  stopped the turn). */
export const AGENT_UI_ERRORS = [
  'no_session',
  'stopped',
  'user_took_over',
  'not_found',
  'ambiguous',
  'stale_ref',
  'needs_user',
  'secret_field',
  'host_control',
  'bad_route',
  'unsupported',
  'timeout',
  'needs_consent',
  'window_gone',
] as const;
export type AgentUiError = (typeof AGENT_UI_ERRORS)[number];

/** An element the agent names: by its id, by its role and accessible name,
 *  or by a ref from the last `ui_screen`. */
export type AgentUiTarget = { id: string } | { role: string; name: string } | { ref: string };

/** What the window answers for one call. */
export type AgentUiResult =
  ({ ok: true } & Record<string, unknown>) | { ok: false; error: AgentUiError; message: string };

/** The per-login setting (GET/PUT /api/profile/agent-ui). */
export type AgentUiSetting = { enabled: boolean };
