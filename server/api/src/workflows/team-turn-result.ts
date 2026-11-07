/**
 * A team turn run's result (workflows/team-turn.ts): the rows' ids and
 * status, never their text. The Runners screen shows a run's output to
 * every Admin user, and a member's reply may quote what only the member
 * reads (a reply marked used_private, docs/agent-ui.md).
 */
import type { TeamTurnRunResult } from '@mantle/runtime/assistant';

type Ran = {
  inbound: { id: string; createdAt: Date | string };
  outbound: {
    id: string;
    status: string;
    model: string | null;
    traceId?: string | null;
    createdAt: Date | string;
  };
  reply: string;
};

/** The run's result: the rows' ids and status, never their text. */
export function teamTurnResultOf(r: Ran): TeamTurnRunResult {
  return {
    inbound: { id: r.inbound.id, createdAt: new Date(r.inbound.createdAt).toISOString() },
    outbound: {
      id: r.outbound.id,
      status: r.outbound.status,
      model: r.outbound.model,
      traceId: r.outbound.traceId ?? null,
      createdAt: new Date(r.outbound.createdAt).toISOString(),
    },
    replyChars: r.reply.length,
  };
}
