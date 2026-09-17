/**
 * Responder simulation: the real pipeline (persona, retrieval, real tool
 * execution) with nothing persisted to the conversation store.
 *
 * Lifted out of registerMantleTools; bodies moved verbatim.
 */

import { z } from 'zod';
import { describeResponderPersona, runSimulatedResponderTurn } from '@mantle/runtime/assistant';
import { errorMessage } from '@mantle/std';
import type { McpRegisterContext } from './context';

export function registerResponderTools(ctx: McpRegisterContext): void {
  const { server, ownerId, jsonReply } = ctx;

  // ─── Responder simulation ─────────────────────────────────────────────────────
  // Talk to a responder agent over MCP with the REAL pipeline (persona +
  // retrieval + real tool execution) but NOTHING persisted to its conversation
  // store. Input caps mirror the web Studio sandbox (40 turns, 8000 chars each).
  const SIM_MAX_HISTORY = 40;
  const SIM_MAX_CONTENT = 8000;
  const SIM_ARGS_CLIP = 500;
  /** Shared handler for `ask_responder` and its deprecated alias. */
  async function askResponder(a: {
    message: string;
    agent_slug?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    exclude_tools?: string[];
    read_only?: boolean;
    max_iterations?: number;
    include_tool_calls?: boolean;
    toolName: string;
  }) {
    // Cap the caller-held transcript before it reaches the model — an
    // unbounded resend would blow the context budget. Reject with a corrective
    // (say the limit + the fix) rather than silently truncating history.
    if (a.message.length > SIM_MAX_CONTENT) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${a.toolName}: message is ${a.message.length} chars (max ${SIM_MAX_CONTENT}) — ` +
              'shorten it, or put the bulk in a file/page and reference it.',
          },
        ],
        isError: true,
      };
    }
    if (a.history && a.history.length > SIM_MAX_HISTORY) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${a.toolName}: history has ${a.history.length} turns (max ${SIM_MAX_HISTORY}) — ` +
              'drop the oldest turns and resend, or start a fresh transcript.',
          },
        ],
        isError: true,
      };
    }
    const tooLong = (a.history ?? []).findIndex((t) => t.content.length > SIM_MAX_CONTENT);
    if (tooLong >= 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${a.toolName}: history entry ${tooLong} is ${a.history![tooLong]!.content.length} ` +
              `chars (max ${SIM_MAX_CONTENT}) — shorten or summarise that turn and resend.`,
          },
        ],
        isError: true,
      };
    }
    try {
      const res = await runSimulatedResponderTurn(ownerId, {
        message: a.message,
        ...(a.agent_slug ? { agentSlug: a.agent_slug } : {}),
        ...(a.history ? { history: a.history } : {}),
        ...(a.exclude_tools ? { excludeToolSlugs: a.exclude_tools } : {}),
        ...(a.read_only ? { readOnly: true } : {}),
        ...(typeof a.max_iterations === 'number' ? { maxIterations: a.max_iterations } : {}),
      });
      const withCalls = a.include_tool_calls !== false;
      return jsonReply({
        reply: res.reply,
        agent: res.agent,
        read_only: a.read_only === true,
        ...(withCalls
          ? {
              tool_calls: res.toolCalls.map((tc) => ({
                slug: tc.slug,
                status: tc.status,
                duration_ms: tc.durationMs,
                // Clip args so a large payload doesn't blow the reply budget.
                args:
                  tc.argsJson.length > SIM_ARGS_CLIP
                    ? `${tc.argsJson.slice(0, SIM_ARGS_CLIP)}…`
                    : tc.argsJson,
                ...(tc.error ? { error: tc.error } : {}),
              })),
            }
          : {}),
        tool_stats: res.toolStats,
        pending_ids: res.pendingIds,
        trace_id: res.traceId,
        empty_reply_substituted: res.emptyReplySubstituted,
      });
    } catch (err) {
      const msg = errorMessage(err);
      return {
        content: [{ type: 'text' as const, text: `${a.toolName} failed: ${msg}` }],
        isError: true,
      };
    }
  }

  const ASK_RESPONDER_SCHEMA = {
    message: z.string().min(1),
    agent_slug: z.string().optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .optional(),
    exclude_tools: z.array(z.string()).optional(),
    read_only: z.boolean().optional(),
    max_iterations: z.number().int().min(1).max(30).optional(),
    include_tool_calls: z.boolean().optional(),
  };

  server.tool(
    'ask_responder',
    "Ask one of the user's responder agents a question and get ITS answer, routed through " +
      'its own persona, memory and tools. Runs ONE real turn server-side: composed persona ' +
      '(identity + skills), real retrieval, real granted tools, real delegation — with every ' +
      "guard and confirm-gate ENFORCED. Writes nothing to the agent's conversation history, " +
      "so it's safe to probe repeatedly. **Tools EXECUTE by default: side effects happen and " +
      'confirm-gated calls land on /pending (`pending_ids`). Pass `read_only` for a probe that ' +
      'cannot write or send anything** — the right default for a post-deploy canary. Multi-turn ' +
      'is caller-held: keep the transcript and resend it in `history`. Omit `agent_slug` for the ' +
      'default responder. To answer AS the responder in your own loop instead, use ' +
      '`ask_as_responder`.',
    ASK_RESPONDER_SCHEMA,
    async (a) => askResponder({ ...a, toolName: 'ask_responder' }),
  );

  server.tool(
    'ask_as_responder',
    "Adopt a responder's persona and answer as it YOURSELF, in your own loop. Returns the " +
      'composed system prompt (identity + skills + house style), the skill list, the tool slugs ' +
      'it would hold and its delegation edges — no model call, no tool run, nothing written. ' +
      'Use when you want to sound and reason like the responder across a long stretch of your ' +
      'own work. **What comes back is teaching, NOT permission: nothing here constrains you.** ' +
      '`delegate_to` is a list rather than a gate, `tool_slugs` is what the responder would be ' +
      'granted rather than what you can call, and confirm-gating, /pending parking and the loop ' +
      'guards stay on the server. When the rules must actually be enforced, use `ask_responder` ' +
      'and let the brain run the turn. Pass `read_only` to see the narrowed tool list a ' +
      'read-only probe would get.',
    {
      agent_slug: z.string().optional(),
      read_only: z.boolean().optional(),
    },
    async ({ agent_slug, read_only }) => {
      try {
        const p = await describeResponderPersona(ownerId, {
          ...(agent_slug ? { agentSlug: agent_slug } : {}),
          ...(read_only ? { readOnly: true } : {}),
        });
        return jsonReply({
          agent: p.agent,
          system_prompt: p.systemPrompt,
          skills: p.skills,
          tool_slugs: p.toolSlugs,
          delegate_to: p.delegateTo,
          read_only: p.readOnly,
          advisory: p.advisory,
        });
      } catch (err) {
        const msg = errorMessage(err);
        return {
          content: [{ type: 'text' as const, text: `ask_as_responder failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
