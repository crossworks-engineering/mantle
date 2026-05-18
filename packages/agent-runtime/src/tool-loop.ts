/**
 * Multi-turn tool-call loop. Wraps a single OpenRouter chat into an
 * iterative cycle:
 *
 *   1. send messages → assistant response
 *   2. if response.toolCalls present:
 *         append the assistant message,
 *         dispatch each tool locally,
 *         append a tool message per call,
 *         goto 1
 *      else return the text reply
 *
 * Each LLM round goes in a `step({kind: 'llm_call'})` so cost + tokens
 * roll into the parent trace. Each tool call gets its own
 * `step({kind: 'compute'})` so the reactflow visual shows the full
 * chain. Failures inside tool handlers don't kill the loop — they're
 * surfaced to the model as tool results so it can recover.
 */

import type { OpenRouter } from '@openrouter/sdk';
import { step } from '@mantle/tracing';
import {
  dispatchTool,
  resolveTools,
  type ToolCallRecord,
} from '@mantle/tools';
import type { Tool, AgentParams } from '@mantle/db';
import { captureLlmUsage } from './llm-usage';
import type { ChatMessage } from './messages';

const DEFAULT_MAX_ITERATIONS = 6;

export type ToolLoopResult = {
  /** Final assistant text response (last turn's `content`). */
  reply: string;
  /** Full message chain after the loop completed. Includes every
   *  assistant + tool round. Caller can persist this if they want. */
  messages: ChatMessage[];
  /** Number of LLM round-trips (1 = no tool calls, just one response). */
  iterations: number;
  /** Per-tool-call telemetry. */
  toolCalls: ToolCallRecord[];
};

export type ToolLoopArgs = {
  client: OpenRouter;
  model: string;
  params: AgentParams;
  ownerId: string;
  /** Initial messages: system + any history + the new user turn. */
  initialMessages: ChatMessage[];
  /** Tool rows the agent is permitted to use. Empty array → no tools sent. */
  tools: Tool[];
  /** Max LLM round-trips before forcing a final answer. Default 6. */
  maxIterations?: number;
};

/**
 * Resolve a set of slugs to enabled tool rows. Convenience for callers
 * that have slugs (from agent.tool_slugs + skill.tool_slugs union) but
 * not the full rows yet.
 */
export async function resolveAgentTools(
  ownerId: string,
  slugs: string[],
): Promise<Tool[]> {
  if (slugs.length === 0) return [];
  return resolveTools(ownerId, slugs);
}

/**
 * Convert resolved tools to the OpenRouter `tools` parameter shape.
 * The slug becomes the function name (no remapping at runtime —
 * keeps the model's tool_use names directly resolvable).
 */
export function buildToolsForModel(tools: Tool[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.slug,
      description: t.description,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

export async function runToolLoop(args: ToolLoopArgs): Promise<ToolLoopResult> {
  const maxIters = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolsByName = new Map(args.tools.map((t) => [t.slug, t]));
  const toolsForModel = buildToolsForModel(args.tools);
  const sendTools = toolsForModel.length > 0;

  const messages: ChatMessage[] = [...args.initialMessages];
  const toolCalls: ToolCallRecord[] = [];

  for (let iter = 0; iter < maxIters; iter++) {
    const result = await step(
      {
        name: iter === 0 ? 'openrouter_chat' : `openrouter_chat[${iter}]`,
        kind: 'llm_call',
        input: { model: args.model, iter, tools: toolsForModel.length },
      },
      async (h) => {
        const r = await args.client.chat.send({
          chatRequest: {
            model: args.model,
            // Cast: ChatMessage extends the SDK's union but the SDK's
            // input zod is strict about the shape. We've matched it
            // exactly above; the cast is just to silence TS.
            messages: messages as unknown as Parameters<typeof args.client.chat.send>[0]['chatRequest']['messages'],
            ...(sendTools ? { tools: toolsForModel as unknown as Parameters<typeof args.client.chat.send>[0]['chatRequest']['tools'] } : {}),
            ...(typeof args.params.temperature === 'number' ? { temperature: args.params.temperature } : {}),
            ...(typeof args.params.max_tokens === 'number' ? { maxTokens: args.params.max_tokens } : {}),
            ...(typeof args.params.top_p === 'number' ? { topP: args.params.top_p } : {}),
          },
        });
        captureLlmUsage(h, r, args.model);
        return r;
      },
    );

    if (!('choices' in result)) {
      throw new Error('tool_loop: unexpected streaming response');
    }
    const msg = result.choices[0]?.message;
    const calls = (msg && 'toolCalls' in msg ? msg.toolCalls : undefined) as
      | Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      | undefined;

    if (!calls || calls.length === 0) {
      // Final text response. Done.
      const raw = msg && 'content' in msg ? msg.content : null;
      const text = typeof raw === 'string' ? raw.trim() : '';
      messages.push({ role: 'assistant', content: text });
      return { reply: text, messages, iterations: iter + 1, toolCalls };
    }

    // Push the assistant message verbatim so the next LLM call sees its
    // own prior tool_calls + the upcoming tool results in the right
    // pairing. content may be empty when the model only wanted to call.
    messages.push({
      role: 'assistant',
      content:
        msg && 'content' in msg && typeof msg.content === 'string' ? msg.content : null,
      toolCalls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    });

    // Execute each call, append tool message.
    for (const call of calls) {
      const startedAt = Date.now();
      const slug = call.function.name;
      const tool = toolsByName.get(slug);
      let input: Record<string, unknown> = {};
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        /* leave empty */
      }

      const outcome = await step(
        {
          name: `tool: ${slug}`,
          kind: 'compute',
          input: { slug, args: input },
        },
        async (handle) => {
          if (!tool) {
            handle.setMeta({ error: 'tool not in agent allowlist' });
            return {
              ok: false as const,
              error: `tool '${slug}' is not in this agent's allowlist`,
            };
          }
          return dispatchTool(tool, input, {
            ownerId: args.ownerId,
            step: {
              setMeta: (m) => handle.setMeta(m),
              setOutput: (o) => handle.setOutput(o),
            },
          });
        },
      );

      const duration = Date.now() - startedAt;
      toolCalls.push({
        slug,
        argsJson: call.function.arguments ?? '{}',
        durationMs: duration,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.ok ? undefined : outcome.error,
      });

      // Feed the result back to the model. Errors are sent as JSON too —
      // the model usually adapts (retries with different args, falls
      // back to a plain answer) rather than blowing up.
      const payload = outcome.ok
        ? truncateForModel(JSON.stringify(outcome.output))
        : JSON.stringify({ error: outcome.error });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: payload,
      });
    }
  }

  // Loop exhausted without a final text response. Last message is a
  // tool result; force one more answer-only call so we don't return
  // nothing. This is a safety net — typical conversations finish well
  // under maxIters.
  const finalResult = await step(
    {
      name: 'openrouter_chat[force_final]',
      kind: 'llm_call',
      input: { model: args.model, reason: 'max_iters_reached' },
    },
    async (h) => {
      const r = await args.client.chat.send({
        chatRequest: {
          model: args.model,
          messages: messages as unknown as Parameters<typeof args.client.chat.send>[0]['chatRequest']['messages'],
          // No tools on the final pass — force a text answer.
        },
      });
      captureLlmUsage(h, r, args.model);
      return r;
    },
  );
  if (!('choices' in finalResult)) {
    throw new Error('tool_loop: unexpected streaming response on force_final');
  }
  const lastMsg = finalResult.choices[0]?.message;
  const raw = lastMsg && 'content' in lastMsg ? lastMsg.content : null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  messages.push({ role: 'assistant', content: text });
  return { reply: text, messages, iterations: maxIters + 1, toolCalls };
}

const TOOL_RESULT_BYTE_CAP = 8 * 1024;

/** Cap massive tool outputs (e.g. a full file_read of a giant note)
 *  so we don't blow the context window. The model gets a head + tail
 *  and a truncated marker so it knows to ask for a narrower scope. */
function truncateForModel(s: string): string {
  if (s.length <= TOOL_RESULT_BYTE_CAP) return s;
  const head = s.slice(0, TOOL_RESULT_BYTE_CAP / 2);
  const tail = s.slice(s.length - TOOL_RESULT_BYTE_CAP / 4);
  return `${head}\n…[truncated, original ${s.length} chars]…\n${tail}`;
}
