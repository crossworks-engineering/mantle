/**
 * The INPUT of one responder turn, handed to an outside caller: everything the
 * model would be sent, and no model call.
 *
 * The third member of the family:
 *
 *   - run-sim-turn.ts (`ask_responder`): the brain runs the turn, on the
 *     agent's model, billed to the box's key.
 *   - describe-persona.ts (`ask_as_responder`): the composed persona only. No
 *     retrieval for a message, no history, no tool schemas.
 *   - this file (`responder_turn_input`): the per-message input of the turn
 *     `ask_responder` would run, so a caller can answer it with ITS OWN model
 *     (a Claude Code subagent on Sonnet or Haiku) and see what the agent saw.
 *
 * It runs the sim's read path (`prepareSimulatedTurn`: agent pick, retrieval,
 * assembly) and its message builder (`buildSimulatedMessages`), then the tool
 * loop's own tool-list step (`withReadResultTool` + `buildToolsForModel`).
 * Nothing is forked, so the payload is the turn's input byte for byte. Then
 * it stops: no chat call, no tool run, nothing written to the conversation
 * store. One trace is opened (kind 'manual'), so the retrieval snapshot is on
 * /debug/context like any turn's.
 *
 * Retrieval still runs its own workers, as on every turn: the query embed and,
 * when the owner has them on, the decider's scoring calls. Those are the
 * brain's cost; the chat model call is the one that moves to the caller.
 *
 * ⚠️ Same warning as describe-persona.ts: this is INPUT, not ENFORCEMENT. The
 * caller's model answers with the caller's own tools. Confirm gates, /pending
 * parking, the loop guards and the delegation allowlist stay in the brain's
 * loop. `DIFFERENCES` says so in-band.
 */

import type { AgentParams } from '@mantle/db';
import { delegationHintTraceData } from '@mantle/decisions';
import { startTrace, currentTrace } from '@mantle/tracing';
import {
  DEFAULT_MAX_ITERATIONS,
  buildToolsForModel,
  withAgentViewer,
  withReadResultTool,
  type ChatMessage,
} from '../agent';
import { STABLE_PREFIX } from '../agent/messages';
import { loadContextStep } from './responder-loop';
import {
  buildSimulatedMessages,
  prepareSimulatedTurn,
  resolveSimAgent,
  type SimHistoryTurn,
} from './run-sim-turn';
import { CLIENT_RESPONDER_SLUG, TEAM_RESPONDER_SLUG } from './run-team-turn';

export type DescribeResponderTurnInputOptions = {
  /** Which responder. Omit → the web-default responder. */
  agentSlug?: string;
  /** The user's message for this turn. */
  message: string;
  /** Prior turns, caller-held, oldest first. Cut to the agent's history
   *  window, as the real turn cuts its stored one. */
  history?: SimHistoryTurn[];
  /** Slugs removed from the tool allowlist after group resolution. */
  excludeToolSlugs?: string[];
  /** The tool list a read-only probe would get. */
  readOnly?: boolean;
};

/** One prompt message as sent. `cached` marks the stable prefix blocks (an
 *  explicit cache marker on Anthropic, the implicit prefix elsewhere); the
 *  rest change per message. */
export type TurnInputMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  cached: boolean;
};

export type TurnInputTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ResponderTurnInput = {
  agent: { slug: string; name: string; model: string; provider: string };
  readOnly: boolean;
  /** The prompt in order: system blocks, then history, then the new message. */
  messages: TurnInputMessage[];
  /** The tools as the model is sent them: names, descriptions (after any
   *  dynamic-schema hook) and parameter schemas, `read_result` included. */
  tools: TurnInputTool[];
  /** The loop settings the brain would run this turn with. Reported, not
   *  applied: the caller's own client decides its loop. */
  loop: {
    maxIterations: number;
    maxToolCallsPerTurn: number | null;
    maxCallsPerToolPerTurn: number | null;
    thinkingBudget: number | null;
    thinkingEffort: string | null;
    delegateTo: string[];
    params: Pick<AgentParams, 'temperature' | 'max_tokens' | 'top_p'>;
  };
  /** What retrieval put in the prompt, counted. */
  context: {
    historyTurns: number;
    digests: number;
    facts: number;
    contentHits: number;
    passages: number;
    corpusMapEntries: number;
    relations: number;
    personaNotes: number;
    delegationHint: unknown;
  };
  /** The trace holding the retrieval snapshot (/traces, /debug/context). */
  traceId: string | null;
  /** What still differs from a real turn, in plain words. */
  differences: string[];
};

/** Returned in-band, next to the payload it qualifies. */
export const TURN_INPUT_DIFFERENCES: readonly string[] = [
  'Your client adds its own system prompt and its own tools around these messages. The agent gets neither.',
  'Your model answers, not the agent model named in `agent.model`. Thinking budget and params in `loop` are reported, not applied.',
  'Your tool calls run on the MCP surface, not in the brain loop. Some names and schemas differ there (the agent has `search_nodes`, MCP has `search`; page/table/file reads return other shapes). Confirm gates, /pending parking, loop guards, tool-call caps, result spill and the delegation allowlist do NOT apply.',
  'The brain adds system nudges mid-loop (tool budget spent, iteration limit, guard blocks). Your loop gets none.',
  'Like ask_responder: no open-heartbeat block, no device-location line, and digests and history recall come from the stored conversation, not your history.',
];

/** The two role responders assemble their own turn (run-team-turn.ts: no
 *  owner identity, no thinking, the private-reads gate). This file mirrors the
 *  owner turn, so for those two it would describe a turn that never runs. */
const ROLE_RESPONDERS: ReadonlySet<string> = new Set([TEAM_RESPONDER_SLUG, CLIENT_RESPONDER_SLUG]);

/**
 * Assemble one responder turn's input for `message` and return it. Runs the
 * same read path as {@link runSimulatedResponderTurn}, opens one trace for the
 * retrieval snapshot, and stops before the model call.
 */
export async function describeResponderTurnInput(
  ownerId: string,
  opts: DescribeResponderTurnInputOptions,
): Promise<ResponderTurnInput> {
  const message = opts.message.trim();
  if (!message) throw new Error('describeResponderTurnInput: empty message');

  const agent = await resolveSimAgent(ownerId, opts.agentSlug);
  if (ROLE_RESPONDERS.has(agent.slug)) {
    throw new Error(
      `'${agent.slug}' answers team or client logins, and its turn is assembled differently ` +
        '(no owner identity, no thinking, the private-reads gate). This tool mirrors the owner ' +
        'turn only: pick an owner-facing responder.',
    );
  }

  const prepared = await prepareSimulatedTurn(ownerId, agent, {
    message,
    history: opts.history,
    excludeToolSlugs: opts.excludeToolSlugs,
    readOnly: opts.readOnly,
    logPrefix: '[mcp-turn-input]',
  });
  const { assembled, ctx } = prepared;

  let traceId: string | null = null;
  const built = await startTrace(
    {
      kind: 'manual',
      prelude: prepared.prelude,
      ownerId,
      subjectKind: 'agent',
      subjectId: agent.id,
      agentId: agent.id,
      data: {
        surface: 'mcp_turn_input',
        model: agent.model,
        agent_slug: agent.slug,
        tool_count: assembled.allowedTools.length,
        read_only: opts.readOnly === true,
        delegation_hint: delegationHintTraceData(assembled.delegationHint),
      },
    },
    async () => {
      traceId = currentTrace()?.id ?? null;
      await loadContextStep(async () => ctx, { agentId: agent.id });
      const messages = buildSimulatedMessages(prepared);
      // The tool loop's own steps, at the agent's level as the loop runs them
      // (a dynamic-schema hook reads the brain).
      const tools = await withAgentViewer(agent, async () =>
        buildToolsForModel(await withReadResultTool(ownerId, assembled.allowedTools), {
          ownerId,
          delegateTo: assembled.delegateTo,
        }),
      );
      return { messages, tools };
    },
  );

  const params = (agent.params ?? {}) as AgentParams;
  return {
    agent: { slug: agent.slug, name: agent.name, model: agent.model, provider: agent.provider },
    readOnly: opts.readOnly === true,
    messages: built.messages.flatMap(toTurnInputMessage),
    tools: built.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
    })),
    loop: {
      maxIterations: assembled.loopOverrides.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxToolCallsPerTurn: assembled.loopOverrides.maxToolCallsPerTurn ?? null,
      maxCallsPerToolPerTurn: assembled.loopOverrides.maxCallsPerToolPerTurn ?? null,
      thinkingBudget: assembled.thinkingBudget ?? null,
      thinkingEffort: assembled.thinkingEffort ?? null,
      delegateTo: assembled.delegateTo,
      params: {
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.max_tokens !== undefined ? { max_tokens: params.max_tokens } : {}),
        ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
      },
    },
    context: {
      historyTurns: prepared.history.length,
      digests: ctx.digests.length,
      facts: ctx.facts.length,
      contentHits: ctx.contentHits.length,
      passages: ctx.chunkHits.length,
      corpusMapEntries: ctx.corpusMap.entries.length,
      relations: ctx.relations.length,
      personaNotes: ctx.personaNotes.length,
      delegationHint: delegationHintTraceData(assembled.delegationHint),
    },
    traceId,
    differences: [...TURN_INPUT_DIFFERENCES],
  };
}

/** A built message as plain text. The sim builds no tool messages and no
 *  images, so system, user and assistant text is all there is. */
function toTurnInputMessage(m: ChatMessage): TurnInputMessage[] {
  if (m.role === 'tool') return [];
  const content = m.content;
  if (typeof content === 'string' || content === null) {
    return [
      {
        role: m.role,
        content: content ?? '',
        cached: m.role === 'system' && m[STABLE_PREFIX] === true,
      },
    ];
  }
  const parts = content as Array<{ type: string; text?: string; cacheControl?: unknown }>;
  return [
    {
      role: m.role,
      content: parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n'),
      cached: parts.some((p) => p.cacheControl !== undefined),
    },
  ];
}
