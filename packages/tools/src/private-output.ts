/**
 * Tools whose result may be a person's PRIVATE content: the agent UI tools
 * (ui_*, docs/agent-ui.md). What a person's window shows can hold its own
 * private items, its direct messages and the other workspaces it is in, so
 * a ui tool's result is handled as private on every turn (a member's
 * workspace turn and an Admin user's turn alike): wherever a turn keeps or
 * shows tool results beyond the turn itself, these are left out:
 *
 *  · the tool step is not journaled by the durable engine (its result never
 *    lands in the workflow store; a ui call is safe to run again on a resume,
 *    its ui_calls row is found again by its step key), and the result is
 *    never spilled to the tool-result store (a handle in a trace would open
 *    it);
 *  · a team reply from a turn that used one is marked `used_private`, and the
 *    admin readers of member chats show a placeholder instead of the text.
 *
 * The trace keeps no result of these either: the tool step records its
 * redacted input only, the ui_action step the action, a short target
 * summary and ok or the error code (packages/runtime/src/agent-ui/tools.ts).
 *
 * Single source of truth: the tool loop and the team turn import this set.
 */
import { AGENT_UI_ACTIONS } from '@mantle/client-types/agent-ui';

export const PRIVATE_OUTPUT_TOOL_SLUGS: ReadonlySet<string> = new Set<string>(
  AGENT_UI_ACTIONS.map((a) => `ui_${a}`),
);
