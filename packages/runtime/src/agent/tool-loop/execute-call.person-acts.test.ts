/**
 * The one rule (packages/tools/src/person-only-acts.ts): an agent may tighten a
 * gate, never loosen one. Through the tool loop's own step, executeToolCall, in
 * every mode a box may run the loop's validation in, with the real dispatcher.
 *
 * No database: the call is answered before any tool runs.
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';
import { BUILTIN_TOOLS, validateToolArgs } from '@mantle/tools';
import type { ToolLoopArgs, ToolValidationMode } from '../tool-loop';
import { executeToolCall } from './execute-call';

const LOGIN = '00000000-0000-4000-8000-0000000000aa';
const def = BUILTIN_TOOLS.find((t) => t.slug === 'api_tool_update')!;
const tool = {
  slug: def.slug,
  handler: { kind: 'builtin', ref: def.slug },
  inputSchema: def.inputSchema,
  requiresConfirm: false,
} as unknown as Tool;

/** One call of the tool in a turn, as the loop makes it. */
const callInMode = (mode: ToolValidationMode, raw: Record<string, unknown>) => {
  const argValidation =
    mode === 'off'
      ? null
      : validateToolArgs(tool.inputSchema as Record<string, unknown>, raw, tool.slug);
  return executeToolCall({
    args: { ownerId: 'owner-1', surface: { kind: 'web', loginId: LOGIN } } as ToolLoopArgs,
    slug: tool.slug,
    call: { id: 'c1', function: { name: tool.slug, arguments: JSON.stringify(raw) } },
    tool,
    input: argValidation?.input ?? raw,
    argParseError: null,
    argValidation,
    argValidationMode: mode,
    lastUserMessage: undefined,
    pendingIds: [],
  });
};

describe.each<ToolValidationMode>(['enforce', 'warn', 'off'])('a turn, validation %s', (mode) => {
  it.each([[false], [0], ['no'], [{}], [[]]])(
    'an agent may not send requires_confirm as %j',
    async (requires_confirm) => {
      const res = await callInMode(mode, { slug: 'x', requires_confirm });
      expect(res.ok).toBe(false);
      // Refused in every mode, in the words of what answered.
      const stoppedBySchema = mode === 'enforce' && requires_confirm !== false;
      expect(res.ok ? '' : res.error).toMatch(
        stoppedBySchema ? /requires_confirm/ : /a person's act/,
      );
    },
  );
});
