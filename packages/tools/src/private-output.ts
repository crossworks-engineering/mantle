/**
 * Tools whose result is a member's PRIVATE content: none today (a member's
 * own items are brain items in its private workspace, which no assistant
 * reads). Kept as the one list a future such tool joins: wherever a turn keeps
 * or shows tool results beyond the turn itself, these are left out:
 *
 *  · the tool step is not journaled by the durable engine (a read, safe to
 *    run again on a resume), and the result is never spilled to the
 *    tool-result store (a handle in a trace would open it);
 *  · a team reply from a turn that used one is marked `used_private`, and the
 *    admin readers of member chats show a placeholder instead of the text.
 *
 * Single source of truth: the tool loop and the team turn import this set.
 */
export const PRIVATE_OUTPUT_TOOL_SLUGS: ReadonlySet<string> = new Set<string>([]);
