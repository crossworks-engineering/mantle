import { sql } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { traces } from './traces';

export const pendingToolStatus = pgEnum('pending_tool_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);

/**
 * The scope a pending call was asked in (workspaces arch A5 step 6c, 0288),
 * set by the server at queue time (@mantle/tools pending-origin.ts): the
 * approval judges it again, and runs it, in this scope met with the asker's
 * rights then (pending-approval.ts originApproval). Version 1.
 */
export type PendingOrigin = {
  v: 1;
  /** The asking turn's scope (its login, its workspaces, its Moderator
   *  workspaces), or null: the turn ran in none (system work, a brain not
   *  on workspaces). */
  scope: {
    kind: 'user' | 'assistant';
    loginId: string | null;
    ws: string[];
    modWs: string[];
  } | null;
  /** How the turn held it: a turn scope (`turn`), or the rollback switch's
   *  gate scope on the system pool (`gate`, MANTLE_ADMIN_READS=system). */
  enter: 'turn' | 'gate' | null;
  /** The turn scope wrote as an Admin turn does (its request mode). */
  writes: boolean;
  /** The Admin view the turn had: whether its scope held Admin, and the
   *  Admin areas it could do. Null with no scope (the surface's rules). */
  admin: { holds: boolean; areas: string[] } | null;
  /** The surface the turn ran on: its kind, an owner path's via, the login
   *  it names (no chat or account ids), and a login's own MCP connection:
   *  how it came in, whether it spends on the owner's keys (lows round, 6c
   *  L3) and the key, peer or OAuth client id its app data log names (lows
   *  round 2, L7; no role, no Write). Null: none. */
  surface: {
    kind: string;
    via?: string;
    loginId?: string;
    mcp?: {
      via: string;
      keyId?: string;
      peerId?: string;
      oauthClientId?: string;
      ownerKeysOff?: true;
    };
  } | null;
  /** The turn ran in a public link's scope (A5 step 6c fix round 1): its
   *  scope is not stamped (a link's served list and its liveness are not
   *  the approval's to rebuild), so only the owner may approve it. */
  link?: true;
  /** The actor the asking turn ran as (A5 step 6c fix round 1): what a row
   *  that names no asker runs as at approval, never the approving path's.
   *  A row with an asker runs as that login now. Absent: none read. */
  actor?:
    | { kind: 'assistant'; agentId: string | null }
    | { kind: 'login'; mode: 'rw' | 'ro' | 'owner'; loginId: string }
    | { kind: 'system'; reason: string; mode?: 'ro' }
    | null;
};

/**
 * Operator-approved tool calls. When a tool with requires_confirm=true
 * is requested mid-turn, the loop persists a row here instead of
 * dispatching; the operator approves/rejects via the /pending UI or
 * the MCP tools.
 */
export const pendingToolCalls = pgTable(
  'pending_tool_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    toolSlug: text('tool_slug').notNull(),
    args: jsonb('args')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    traceId: uuid('trace_id').references(() => traces.id, { onDelete: 'set null' }),
    status: pendingToolStatus('status').default('pending').notNull(),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    /** Workspaces R3 (0250): the workspace this row belongs to, stamped at
     *  insert from its agent (NULL = the Admin workspace), and the login it
     *  was for. The foreign key lives in the migration. */
    workspaceId: uuid('workspace_id'),
    loginId: uuid('login_id'),
    /** Workspaces arch A5 step 6d (0287, owner decision 1a): the call runs
     *  with more rights than the turn that queued it (a connector write its
     *  scope may not make itself), set by the server at queue time; NULL
     *  for every other call. */
    elevated: jsonb('elevated').$type<{ elevated: true; reason: string } | null>(),
    /** The turn that queued the call had read text a client wrote (0287,
     *  A5 step 6d fix round 1): what marked it, for the approver; NULL for
     *  a turn that read none. */
    clientSourced: jsonb('client_sourced').$type<{ via: string } | null>(),
    /** Workspaces arch A5 step 6c (0288): the scope the call was asked in
     *  (PendingOrigin), set by the server at queue time; NULL for a row
     *  queued before 0288 or by no turn (the legacy rule: docs/actors.md). */
    origin: jsonb('origin').$type<PendingOrigin | null>(),
  },
  (t) => [
    index('pending_tool_calls_owner_status_idx').on(t.ownerId, t.status),
    index('pending_tool_calls_owner_created_idx').on(t.ownerId, t.createdAt),
  ],
);

export type PendingToolCall = typeof pendingToolCalls.$inferSelect;
export type NewPendingToolCall = typeof pendingToolCalls.$inferInsert;
