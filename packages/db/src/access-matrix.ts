/**
 * The grant and write matrix (member logins Phase 0b, plan section 2b, review
 * fix M9). ONE list of every table: what the limited viewer roles may read,
 * which row rule filters it, and who writes it. The checklist the tests
 * enforce:
 *
 *  - access-matrix.test.ts: every Drizzle table is listed exactly once, no
 *    draft column is ever granted, the private corpus is never granted.
 *  - access-matrix.db.test.ts: after migrate, the live grants equal this list,
 *    and every `rls` table has row level security on.
 *
 * `applyViewerGrants` turns it into GRANTs at every migrate, so a new table is
 * invisible to a limited role until it is added here: a missing grant fails a
 * query loudly (permission denied), it never leaks.
 *
 * The level roles never write. The personal-space role (`mantle_view_space`,
 * Phase 2) writes its own space only: `space` below lists its tables, and the
 * row rules in migration 0165 hold every read and write to the space its
 * transaction names (`mantle.space_id`).
 */
import type postgres from 'postgres';
import { LIMITED_LEVELS, POOL_ROLES } from './viewer-roles';
import { viewerRoleName, type LimitedLevel } from './viewer';

/** Node types that may go below admin. Mirrors mantle_workspace_kind() in
 *  migration 0159; access-matrix.db.test.ts pins the two together. */
export const WORKSPACE_NODE_TYPES = [
  'page',
  'note',
  'draw',
  'table',
  'file',
  'branch',
  'app',
  // Formulas are authored workspace objects (Jason, 2026-09-26): a
  // team-level agent can evaluate a formula shared with the team.
  'formula',
] as const;

/** What the viewer roles may SELECT: nothing, the whole row, or named
 *  columns only (the draft columns stay admin, plan review fix M3). */
export type LimitedRead = 'none' | 'all' | readonly string[];

/**
 * The row rule for a readable table:
 *  - brain-level: the nodes policy (brain owner, audience, workspace kind);
 *  - follows-node: visible when its node is (EXISTS on nodes);
 *  - source-node: facts, visible when their source node is; no source = admin;
 *  - all-rows: configuration the loop needs; no per-row secrecy.
 */
export type RowRule =
  | 'none'
  | 'brain-level'
  | 'follows-node'
  | 'source-node'
  | 'all-rows'
  // Other members' team-shared personal items: the team role only, and only
  // with mantle.human on (a member request, never an agent). Phase 2.
  | 'team-drafts'
  // The client thread on a client-level brain item (client logins C5,
  // decision 8): comments with thread_scope 'client', read with mantle.human
  // on while the item is a brain item at client level (0194).
  | 'client-thread'
  // Rows at or below the viewer's level by the row's own `audience` column
  // (client logins C1: agents and tool groups for the client role, so a
  // client-level turn never even loads an agent or a group above client).
  | 'level-rows';

/**
 * What the personal-space role may do on a table (Phase 2). `write` =
 * SELECT, INSERT, UPDATE, DELETE on every column (drafts included: they are
 * the member's own working copy). The row rules keep all of it inside the
 * space the transaction names.
 */
export type SpaceAccess = 'none' | 'write';

/**
 * Who writes it: `content` through `db` (so the viewer applies), `system`
 * through `systemDb` (infrastructure a limited turn still writes: traces,
 * spills, counters), `admin` only from owner paths.
 */
export type Writer = 'content' | 'system' | 'admin';

export type TableAccess = {
  table: string;
  /** What the level roles read (each, unless `byRole` says otherwise). */
  read: LimitedRead;
  rule: RowRule;
  writer: Writer;
  /** The personal-space role. Absent = none. */
  space?: SpaceAccess;
  /**
   * Where ONE level role differs from `read` / `rule` (client logins C1,
   * the per-role matrix). The team role keeps what it had: invoke_agent and
   * the delegate roster load admin agents under a team viewer.
   */
  byRole?: Partial<Record<LimitedLevel, { read?: LimitedRead; rule?: RowRule }>>;
  /**
   * What the workspace role (`mantle_view_user`, workspaces W1) may SELECT.
   * Absent = none. Its row rules are the workspace policies of migration
   * 0242 (the row's workspaces meet the scope), not the level rules.
   * 'level': the same columns as `read`.
   */
  user?: LimitedRead | 'level';
};

/** What the workspace role may SELECT on `t`. */
export function userReadFor(t: TableAccess): LimitedRead {
  return t.user === 'level' ? t.read : (t.user ?? 'none');
}

/** What `level`'s role may SELECT on `t`. */
export function readFor(t: TableAccess, level: LimitedLevel): LimitedRead {
  return t.byRole?.[level]?.read ?? t.read;
}

/** The row rule that filters `t` for `level`'s role. */
export function ruleFor(t: TableAccess, level: LimitedLevel): RowRule {
  return t.byRole?.[level]?.rule ?? t.rule;
}

const none = (table: string, writer: Writer = 'admin'): TableAccess => ({
  table,
  read: 'none',
  rule: 'none',
  writer,
});

export const ACCESS_MATRIX: readonly TableAccess[] = [
  // ── Brain content: readable at the viewer's level ─────────────────────────
  {
    table: 'public.nodes',
    read: 'all',
    user: 'all',
    rule: 'brain-level',
    writer: 'content',
    space: 'write',
  },
  {
    table: 'public.content_chunks',
    read: 'all',
    user: 'all',
    rule: 'follows-node',
    writer: 'content',
  },
  {
    table: 'public.content_chunk_windows',
    read: 'all',
    user: 'all',
    rule: 'follows-node',
    writer: 'content',
  },
  { table: 'public.facts', read: 'all', user: 'all', rule: 'source-node', writer: 'content' },
  {
    table: 'public.pages',
    user: 'level',
    read: ['node_id', 'doc', 'doc_text', 'version', 'created_at', 'updated_at'],
    rule: 'follows-node',
    writer: 'content',
    space: 'write',
  },
  {
    table: 'public.draws',
    user: 'level',
    read: [
      'node_id',
      'scene',
      'scene_text',
      'scene_svg',
      'file_refs',
      'version',
      'svg_engine',
      'created_at',
      'updated_at',
    ],
    rule: 'follows-node',
    writer: 'content',
    space: 'write',
  },
  {
    table: 'public.tables',
    user: 'level',
    read: [
      'node_id',
      'data',
      'data_text',
      'version',
      'storage_path',
      'size_bytes',
      'shape_hash',
      'engine_version',
      'stats',
      'created_at',
      'updated_at',
    ],
    rule: 'follows-node',
    writer: 'content',
    space: 'write',
  },
  {
    table: 'public.apps',
    user: 'level',
    read: [
      'node_id',
      'source',
      'source_text',
      'manifest',
      'published_build',
      'version',
      // The informational flag (0198): the member and client app lookups
      // read it on their roles.
      'data_read_only',
      // MCP access (0234): the member and client MCP app lookups read it on
      // their roles.
      'mcp_access',
      'created_at',
      'updated_at',
    ],
    rule: 'follows-node',
    writer: 'content',
  },
  {
    table: 'public.app_databases',
    read: 'all',
    user: 'all',
    rule: 'follows-node',
    writer: 'content',
  },

  // ── Personal spaces (Phase 2) ─────────────────────────────────────────────
  // Sharing and review state of personal items. The team role reads the
  // team-shared rows (team drafts, human requests only); the space role
  // writes its own; the review side (return, accept) is admin.
  {
    table: 'public.space_items',
    read: 'all',
    rule: 'team-drafts',
    writer: 'content',
    space: 'write',
  },
  // The bundle a submitted item was submitted with (0180): the space role
  // records its own at Submit and drops it on Recall; the level roles never
  // see it (the ids of a member's private embeds are nobody else's business).
  {
    table: 'public.space_item_bundles',
    read: 'none',
    rule: 'none',
    writer: 'content',
    space: 'write',
  },
  // Read only through mantle_is_brain_space() (security definer).
  none('public.spaces'),
  // The accepted snapshot a member author reads (0183): the admin pool
  // serves it with the author rule in the query (member-accepted.ts).
  none('public.accepted_snapshots'),
  // The upload ledger (0169): the space role inserts and reads its own
  // space's rows; the level roles never see it.
  { table: 'public.space_uploads', read: 'none', rule: 'none', writer: 'content', space: 'write' },
  // The submission ledger (0194): the client caps count it, Recall cannot
  // reset it. The space role inserts and reads its own space's rows.
  {
    table: 'public.space_submissions',
    read: 'none',
    rule: 'none',
    writer: 'content',
    space: 'write',
  },

  // The client comment ledger (0195): the daily comment cap counts it,
  // deleting a comment never refunds. The space role inserts and reads its
  // own login's rows; the level roles never see it.
  {
    table: 'public.client_comment_ledger',
    read: 'none',
    rule: 'none',
    writer: 'content',
    space: 'write',
  },
  // Client quota refusals (0195): what Team admin > Clients lists. Admin only.
  none('public.client_quota_refusals'),

  // ── Configuration the turn loop reads (no per-row secrecy) ────────────────
  // The client role reads agents and tool groups at client level only
  // (migration 0187, narrowed by 0189: client and public are siblings, not
  // a chain): the team role keeps every row, because a team-level agent may
  // still delegate to an admin agent.
  {
    table: 'public.agents',
    read: 'all',
    rule: 'all-rows',
    writer: 'admin',
    byRole: { client: { rule: 'level-rows' } },
  },
  { table: 'public.tools', read: 'all', rule: 'all-rows', writer: 'admin' },
  {
    table: 'public.tool_groups',
    read: 'all',
    rule: 'all-rows',
    writer: 'admin',
    byRole: { client: { rule: 'level-rows' } },
  },
  { table: 'public.skills', read: 'all', rule: 'all-rows', writer: 'admin' },
  // The client role reads none of it: resolveEmbeddingConfig reads on the
  // admin pool (systemDb), so no client path needs the row with its base
  // URLs (audit A27).
  {
    table: 'public.embedding_config',
    read: 'all',
    rule: 'all-rows',
    writer: 'admin',
    byRole: { client: { read: 'none', rule: 'none' } },
  },
  // Every column for the client role too: the worker resolver
  // (ai-workers-resolve.ts) selects whole rows on the viewer's pool, so a
  // column list would fail a client-level turn (C4). Narrow it there.
  { table: 'public.ai_workers', read: 'all', rule: 'all-rows', writer: 'admin' },
  // The client role reads the preferences only (loadProfilePreferences), not
  // the owner's display name (audit A27).
  {
    table: 'public.profiles',
    read: 'all',
    rule: 'all-rows',
    writer: 'admin',
    byRole: { client: { read: ['user_id', 'preferences'] } },
  },
  // mantle_brain_id() reads the anchor row; nothing else of a login. The
  // client role holds no grant here: mantle_brain_id() is SECURITY DEFINER
  // since migration 0187, so it needs none.
  {
    table: 'auth.users',
    read: ['id', 'is_owner', 'created_at'],
    rule: 'all-rows',
    writer: 'admin',
    byRole: { client: { read: 'none', rule: 'none' } },
  },

  // ── Infrastructure: written through systemDb, never read by a viewer ─────
  none('public.traces', 'system'),
  // Embedding / extraction outages (0230): written by the embedder and the
  // extract queue on the admin pool, read by admin routes only.
  none('public.provider_alerts', 'system'),
  none('public.trace_steps', 'system'),
  none('public.tool_results', 'system'),
  none('public.tool_result_chunks', 'system'),
  none('public.pending_tool_calls', 'system'),
  none('public.turn_stream_buffer', 'system'),
  none('public.audit_log', 'system'),
  none('public.app_access_log', 'system'),
  none('public.team_access_log', 'system'),
  none('public.member_turn_ledger', 'system'),
  none('public.embedding_cache', 'system'),
  none('public.team_messages', 'system'),
  none('public.team_notifications', 'system'),
  none('public.team_read_cursors', 'system'),
  // A member's or a client's own chat read cursor (mobile_roles_push): its own routes
  // read and write it on the admin pool, by the session's login.
  none('public.login_chat_read_cursors', 'system'),
  none('public.assistant_read_cursors', 'system'),
  // Per-login pins and opens of the item tree (docs/folder-tree.md). Owner
  // paths only for now; members get their own when the tree reaches them.
  none('public.item_marks'),
  none('public.sync_runs', 'system'),
  none('public.maintenance_runs', 'system'),
  none('public.heartbeat_fires', 'system'),
  none('public.runs', 'system'),
  none('public.run_items', 'system'),
  // This brain's own id (0226): written once by its migration, read by
  // whoami and the push worker on the admin pool.
  none('public.brain_identity', 'system'),
  none('public.push_instance', 'system'),
  none('public.push_prefs', 'system'),
  none('public.push_subscriptions', 'system'),
  none('public.push_login_prefs', 'system'),
  none('public.shares', 'system'),
  // Contact shares (0214): the /s layer reads and writes these on the admin
  // pool, for the brain. No viewer role ever does.
  none('public.contact_share_codes', 'system'),
  none('public.share_access_log', 'system'),

  // ── Admin only: the private corpus, credentials, the owner's own memory ───
  none('public.api_keys'),
  none('public.secrets'),
  none('public.pdf_passwords'),
  none('public.emails'),
  none('public.email_accounts'),
  none('public.email_attachments'),
  none('public.telegram_accounts'),
  none('public.telegram_chats'),
  none('public.telegram_messages'),
  none('public.calendar_accounts'),
  none('public.ms_accounts'),
  none('public.ms_drives'),
  none('public.ms_drive_items'),
  none('public.ms_drive_scopes'),
  none('public.microsoft_config'),
  none('public.tailscale_config'),
  none('public.oauth_clients'),
  none('public.oauth_auth_codes'),
  none('public.oauth_access_tokens'),
  none('public.mobile_tokens'),
  // MCP as a login (0227): the per-login switch and static token hashes.
  none('public.mcp_login_access'),
  none('public.mcp_login_tokens'),
  // Inbound API keys (0232): hashes of live secrets, admin pool only.
  none('public.access_keys'),
  none('public.pairing_codes'),
  none('public.member_invites'),
  // "What clients see" acknowledgements (0187): an admin's record.
  none('public.client_report_acks'),
  // Client sign-in codes and links (0188): hashes of live secrets.
  none('public.client_signin_codes'),
  // Skipped code requests and the sign-in sender's held folders (0193).
  none('public.client_signin_code_skips'),
  none('public.client_signin_sender_folders'),
  // The lowering guard's marks and the client request ledger (0197): the
  // tool loop and client_request_create write them as the system.
  none('public.client_sourced_nodes', 'system'),
  none('public.conversation_taints', 'system'),
  none('public.client_request_filings', 'system'),
  none('public.mantle_peers'),
  none('public.peer_shares'),
  none('public.peer_share_scopes'),
  none('public.assistant_messages'),
  // Chat archive threads (0231): time ranges over assistant_messages, admin pool.
  none('public.chat_threads'),
  none('public.entities', 'content'),
  none('public.entity_edges', 'content'),
  none('public.entity_merge_dismissals'),
  // The embed edges (0208): written by triggers, read by the refresh and
  // the admin pool; the viewer roles read embedded_level on the row.
  none('public.node_embeds', 'content'),
  // Old summaries made before always fold (W2, 0247): admin pool only.
  none('public.node_mixed_summaries', 'content'),
  none('public.recall_maps'),
  none('public.recall_nodes'),
  // Recall v2: the revision log. Admin pool only, like the other two — the
  // reader filter for a team agent (R6) runs in the tools against the map's
  // node under the viewer, never by opening these tables to a viewer role.
  none('public.recall_revisions'),
  // Comments on personal items (Phase 2): the space role reads and writes its
  // own login's comments on its own items; the team role reads the comments on
  // teammates' team-shared items (human flag on). Brain threads stay admin.
  {
    table: 'public.node_comments',
    read: 'all',
    rule: 'team-drafts',
    writer: 'content',
    space: 'write',
    // The team role reads the client thread too (same policy); the client
    // role reads ONLY that thread (0194).
    byRole: { client: { rule: 'client-thread' } },
  },
  none('public.agent_groups'),
  none('public.channels'),
  none('public.curated_models'),
  none('public.prompt_versions'),
  none('public.node_snapshots'),
  none('public.doc_collections'),
  none('public.ingest_rules'),
  none('public.saved_filters'),
  none('public.heartbeats'),
  none('public.sandboxes'),
  none('public.app_table_exports'),

  // ── Workspaces (W1, migrations 0241 and 0242) ────────────────────────────
  // The model: the workspace role reads the rows of the workspaces in its
  // scope (and the grants of the items it reads); the level roles never do.
  {
    table: 'public.workspaces',
    read: 'none',
    rule: 'none',
    writer: 'admin',
    user: ['id', 'name', 'description', 'contact_id', 'is_admin', 'archived_at'],
  },
  {
    table: 'public.workspace_users',
    read: 'none',
    rule: 'none',
    writer: 'admin',
    user: ['workspace_id', 'login_id', 'moderator'],
  },
  {
    table: 'public.workspace_resources',
    read: 'none',
    rule: 'none',
    writer: 'admin',
    // Never `settings`: a resource's settings may carry configuration the
    // users of the workspace have no business reading (audit L11).
    user: ['id', 'workspace_id', 'type', 'ref_id', 'write'],
  },
  {
    table: 'public.item_grants',
    read: 'none',
    rule: 'none',
    writer: 'content',
    user: ['node_id', 'workspace_id', 'write', 'is_home', 'via_folder_id', 'excluded'],
  },
  // Audit of workspace changes, the heads rows and the heads-check log:
  // admin pool only (the lock functions are security definer).
  none('public.workspace_events'),
  none('public.node_acl_head', 'content'),
  none('public.heads_check_misses', 'system'),
  // The key the held-heads list is signed with: definer functions only.
  none('public.mantle_heads_key', 'system'),
  // The move triggers' per-transaction list of moved rows: definer only.
  none('public.mantle_moved_nodes', 'system'),
];

/** Columns no viewer role may ever read, whatever the matrix says. */
export const NEVER_GRANTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.pages': ['draft_doc', 'draft_updated_at', 'draft_rev'],
  'public.draws': ['draft_scene', 'draft_updated_at', 'draft_rev'],
  'public.tables': ['draft_data', 'draft_updated_at', 'draft_rev'],
  'public.apps': ['draft_source', 'draft_updated_at', 'draft_build'],
  'auth.users': ['password_hash', 'email'],
};

function quoteTable(table: string): string {
  const [schema, name] = table.split('.');
  return `"${schema}"."${name}"`;
}

/** The GRANT statements the matrix means, for one level role. Pure. */
export function viewerGrantStatements(level: LimitedLevel): string[] {
  const role = viewerRoleName(level);
  const out: string[] = [];
  for (const t of ACCESS_MATRIX) {
    const read = readFor(t, level);
    if (read === 'none') continue;
    const cols = read === 'all' ? '' : ` (${read.map((c) => `"${c}"`).join(', ')})`;
    out.push(`GRANT SELECT${cols} ON ${quoteTable(t.table)} TO "${role}"`);
  }
  return out;
}

/** The GRANT statements for the personal-space role. Pure. */
export function spaceGrantStatements(role: string = viewerRoleName('space')): string[] {
  const out: string[] = [];
  for (const t of ACCESS_MATRIX) {
    if ((t.space ?? 'none') === 'none') continue;
    out.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteTable(t.table)} TO "${role}"`);
  }
  return out;
}

/** The GRANT statements for the workspace role (`mantle_view_user`). Pure. */
export function userGrantStatements(role: string = viewerRoleName('user')): string[] {
  const out: string[] = [];
  for (const t of ACCESS_MATRIX) {
    const read = userReadFor(t);
    if (read === 'none') continue;
    const cols = read === 'all' ? '' : ` (${read.map((c) => `"${c}"`).join(', ')})`;
    out.push(`GRANT SELECT${cols} ON ${quoteTable(t.table)} TO "${role}"`);
  }
  return out;
}

/**
 * Make the live grants equal the matrix: revoke everything the limited roles
 * hold on every table in the matrix, then grant what it lists. One
 * transaction, idempotent; migrate runs it after the migrations.
 */
export async function applyViewerGrants(sql: ReturnType<typeof postgres>): Promise<void> {
  const roleList = POOL_ROLES.map((r) => `"${viewerRoleName(r)}"`).join(', ');
  await sql.begin(async (tx) => {
    await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleList}`);
    await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM ${roleList}`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public, auth TO ${roleList}`);
    for (const level of LIMITED_LEVELS) {
      for (const stmt of viewerGrantStatements(level)) await tx.unsafe(stmt);
    }
    for (const stmt of spaceGrantStatements()) await tx.unsafe(stmt);
    for (const stmt of userGrantStatements()) await tx.unsafe(stmt);
  });
}
