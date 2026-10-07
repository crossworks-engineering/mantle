/**
 * Write a turn an MCP client answered AS a responder into that responder's
 * conversation, so it shows in the Assistant window like any turn.
 *
 * The other half of turn-input.ts (`responder_turn_input`): there the client
 * gets the exact input of one turn and answers it with its own model; here it
 * hands back the user's message and its reply, and both land in
 * assistant_messages through `recordTurn`, the writer a real web turn uses. So
 * the history window, the digests, replay and the Assistant window all see it.
 *
 * Opt-in by construction: nothing calls this but the `responder_turn_record`
 * MCP tool, and `ask_responder` still writes nothing.
 *
 * What marks the rows apart from a real turn:
 *   - channel 'mcp' (the Assistant window shows it as a badge);
 *   - the outbound row's `model` is the CLIENT's model, and `data.authored_by`
 *     says which client and model wrote it;
 *   - one trace per recorded turn (surface 'mcp_turn_record', subject the
 *     inbound row, like a real turn's), carrying the same authorship.
 *
 * What it deliberately does NOT do (a real turn does some of these):
 *   - no tool-outcome ledger (`toolStats`): the runtime ran no tool, so a
 *     ledger would be the client's claim. `data.mcp_tools` keeps the claim,
 *     labelled as one;
 *   - no reminder-channel update (noteInboundChannel), no follow-up
 *     suggestion, no agent usage bump: the agent did not answer;
 *   - no phone push: the push worker skips channel 'mcp';
 *   - no persona notes: the reflector skips channel 'mcp' in its activity
 *     check and in what it reads (REFLECTOR_SKIPPED_CHANNEL, server/api).
 * The existing triggers on assistant_messages still fire, as for every turn:
 * the live window refresh and the summarizer (digests, which the extractor
 * never reads into facts). Conversation turns are not nodes, so nothing here
 * reaches fact extraction.
 *
 * Chat threads: when the chat archive lands, the open thread id belongs on
 * these two rows the same way a web turn gets it.
 */

import { startTrace, currentTrace } from '@mantle/tracing';
import { recordTurn } from '../agent';
import { resolveSimAgent } from './run-sim-turn';
import { assertOwnerTurnAgent } from './turn-input';

/** The conversation channel of a recorded MCP turn. */
export const MCP_TURN_CHANNEL = 'mcp' as const;

/** Caps: the user message matches the sim's (8000); a reply may be long, but
 *  not longer than a real reply at the default output ceiling could be. */
export const MCP_TURN_MAX_MESSAGE = 8000;
export const MCP_TURN_MAX_REPLY = 64_000;
const MAX_NAME = 200;
const MAX_TOOLS_LISTED = 100;

export type RecordMcpResponderTurnOptions = {
  /** Which responder's conversation. Omit → the web-default responder. */
  agentSlug?: string;
  /** The user's message, as asked. */
  message: string;
  /** The reply the client's model gave as the agent. */
  reply: string;
  /** The model that wrote the reply (e.g. 'claude-haiku-4-5'). Required: a
   *  turn with no author would read as the agent's own. */
  model: string;
  /** Which client wrote it (e.g. 'claude-code'). Defaults to 'mcp'. */
  client?: string;
  /** The `responder_turn_input` trace the answer was built from, if any. */
  inputTraceId?: string;
  /** Tools the client says it called. Stored as its claim. */
  toolsUsed?: string[];
};

export type RecordMcpResponderTurnResult = {
  agent: { slug: string; name: string };
  inboundId: string;
  outboundId: string;
  traceId: string | null;
};

/**
 * Record one MCP-authored turn into the responder's conversation. Throws on
 * an empty or over-long field, a missing agent, or a team/client responder,
 * before anything is written.
 */
export async function recordMcpResponderTurn(
  ownerId: string,
  opts: RecordMcpResponderTurnOptions,
): Promise<RecordMcpResponderTurnResult> {
  const message = opts.message.trim();
  const reply = opts.reply.trim();
  const model = opts.model.trim();
  const client = opts.client?.trim() || 'mcp';
  if (!message) throw new Error('recordMcpResponderTurn: empty message');
  if (!reply) throw new Error('recordMcpResponderTurn: empty reply');
  if (!model) throw new Error('recordMcpResponderTurn: say which model wrote the reply');
  if (message.length > MCP_TURN_MAX_MESSAGE) {
    throw new Error(`message is ${message.length} chars (max ${MCP_TURN_MAX_MESSAGE})`);
  }
  if (reply.length > MCP_TURN_MAX_REPLY) {
    throw new Error(`reply is ${reply.length} chars (max ${MCP_TURN_MAX_REPLY})`);
  }
  if (model.length > MAX_NAME || client.length > MAX_NAME) {
    throw new Error(`model and client are names, at most ${MAX_NAME} chars`);
  }
  const toolsUsed = (opts.toolsUsed ?? []).slice(0, MAX_TOOLS_LISTED);

  const agent = await resolveSimAgent(ownerId, opts.agentSlug);
  assertOwnerTurnAgent(agent);

  const authoredBy = { model, client };
  const link = opts.inputTraceId ? { input_trace_id: opts.inputTraceId } : {};
  const claimedTools = toolsUsed.length ? { mcp_tools: toolsUsed } : {};

  // Two writes, in order, as a real turn makes them: each its own statement,
  // so the outbound row is strictly newer and the history reads in order.
  const inbound = await recordTurn({
    ownerId,
    agentId: agent.id,
    direction: 'inbound',
    text: message,
    channel: MCP_TURN_CHANNEL,
    data: { via: 'mcp', ...link },
  });
  const outbound = await recordTurn({
    ownerId,
    agentId: agent.id,
    direction: 'outbound',
    text: reply,
    channel: MCP_TURN_CHANNEL,
    model,
    data: { via: 'mcp', authored_by: authoredBy, ...link, ...claimedTools },
  });

  // Who answered, on /traces: subject the inbound row, as a real turn's trace.
  let traceId: string | null = null;
  await startTrace(
    {
      kind: 'manual',
      ownerId,
      subjectKind: 'assistant_message',
      subjectId: inbound.id,
      agentId: agent.id,
      data: {
        surface: 'mcp_turn_record',
        agent_slug: agent.slug,
        agent_model: agent.model,
        authored_by: authoredBy,
        outbound_id: outbound.id,
        ...link,
        ...claimedTools,
      },
    },
    async () => {
      traceId = currentTrace()?.id ?? null;
    },
  );

  return {
    agent: { slug: agent.slug, name: agent.name },
    inboundId: inbound.id,
    outboundId: outbound.id,
    traceId,
  };
}
