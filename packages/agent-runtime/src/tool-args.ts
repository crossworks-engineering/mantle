/**
 * Pure parser for the `arguments` string an LLM emits on a tool call.
 *
 * Two failure modes the model can hit and we previously swallowed:
 *
 *   1. Malformed JSON — used to leave `input = {}` and dispatch as if
 *      the call succeeded, so the model would re-issue the same broken
 *      call indefinitely.
 *   2. A valid JSON value that isn't an object (null, an array, a
 *      bare number) — same outcome.
 *
 * `parseToolArgs` returns a tagged union so the tool-loop can either
 * dispatch with `input`, or send back a structured tool_result error
 * telling the model exactly what was wrong.
 */

export type ToolArgsResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; error: string };

export function parseToolArgs(raw: string | undefined | null): ToolArgsResult {
  if (raw == null || raw === '') {
    // No arguments at all is treated as an empty-object call. Tools
    // that need parameters validate via their inputSchema, so a model
    // calling a parameterised tool with no args gets a downstream
    // error rather than this layer guessing.
    return { ok: true, input: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `tool arguments are not valid JSON (${(err as Error).message})`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'tool arguments must be a JSON object' };
  }
  return { ok: true, input: parsed as Record<string, unknown> };
}
