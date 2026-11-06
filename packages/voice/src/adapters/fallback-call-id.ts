/**
 * The id of a tool call whose provider sent none. Monotonic across the
 * process, never reset per response, as Gemini's synthetic ids are
 * (google-chat.ts): a turn's later round, or a second call of the same tool
 * in one response, never gets an id an earlier call had. The old fallback,
 * `call_<name>`, repeated for every call of a tool, so two calls shared a
 * tool result on the wire and, for the agent UI tools, one window action
 * (their row is keyed on the turn and the call's id; docs/agent-ui.md).
 */
let seq = 0;

export function fallbackToolCallId(name: string): string {
  seq += 1;
  return `call_${name}_${seq}`;
}
