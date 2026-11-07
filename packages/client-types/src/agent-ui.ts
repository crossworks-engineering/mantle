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

/** How long the window has to answer one call, ms (the row's expires_at). */
export const AGENT_UI_CALL_TTL_MS = 15_000;

/** The largest result the window may answer with: its JSON, in bytes. */
export const AGENT_UI_RESULT_MAX_BYTES = 64 * 1024;

/** The largest result that carries a picture (`ui_look`): its JSON, in
 *  bytes. The picture itself is at most AGENT_UI_LOOK_IMAGE_MAX_BYTES. */
export const AGENT_UI_LOOK_MAX_BYTES = 1.5 * 1024 * 1024;

/** The largest picture `ui_look` hands the model, decoded bytes. */
export const AGENT_UI_LOOK_IMAGE_MAX_BYTES = 1024 * 1024;

/** The picture's size: the long side at most this many pixels... */
export const AGENT_UI_LOOK_MAX_SIDE = 1568;
/** ...and at most this many pixels in all (about 1,500 image tokens on
 *  Claude, which resizes anything larger; never scaled up). */
export const AGENT_UI_LOOK_MAX_PIXELS = 1_150_000;

/** What `ui_look` pictures: the main work area (the default), the whole
 *  window, or one element by its `ui_screen` ref. */
export type AgentUiLookScope = 'work' | 'window' | 'ref';

/** The picture in a `look` result. */
export type AgentUiLookImage = { mimeType: 'image/png' | 'image/jpeg'; base64: string };

/** The actions a ui tool asks of the window (the tool is `ui_<action>`). */
export const AGENT_UI_ACTIONS = [
  'screen',
  'look',
  'navigate',
  'click',
  'type',
  'select',
  'point',
  'wait',
] as const;
export type AgentUiAction = (typeof AGENT_UI_ACTIONS)[number];

/** Whether a tool slug is one of the agent UI tools (`ui_<action>`). They
 *  stay in-app: a per-turn affordance, never in a tool group or an agent's
 *  stored tools, never handed to a delegated agent. */
export function isAgentUiToolSlug(slug: string): boolean {
  return slug.startsWith('ui_') && (AGENT_UI_ACTIONS as readonly string[]).includes(slug.slice(3));
}

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
  // A link that leaves the app's origin, or whose path the window's route
  // check refuses (the window's link click).
  'unsafe_route',
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
