/**
 * The grant and write matrix (member logins Phase 0b, plan section 2b, review
 * fix M9; the workspace role from W1 on). ONE list of every table: what the
 * workspace role (`mantle_view_user`) may read, and who writes it. The
 * checklist the tests enforce:
 *
 *  - access-matrix.test.ts: every Drizzle table is listed exactly once, no
 *    login secret is ever granted, the private corpus is never granted.
 *  - access-matrix.db.test.ts: after migrate, the live grants equal this list,
 *    and every table the role reads has row level security on.
 *
 * `applyViewerGrants` turns it into GRANTs at every migrate, so a new table is
 * invisible to the role until it is added here: a missing grant fails a query
 * loudly (permission denied), it never leaks.
 *
 * The level roles and the personal-space role are retired (W6b, W8c): they
 * hold nothing, and applyViewerGrants revokes what an old migration grants
 * them on a fresh install.
 */
import type postgres from 'postgres';
import { POOL_ROLES, RETIRED_POOL_ROLES, withRoleRetry } from './viewer-roles';
import { viewerRoleName } from './viewer';
import { kindsWhere, type WorkspaceKind } from '@mantle/client-types/kinds';

/** The node types that may be granted beyond the Admin workspace: the
 *  'workspace' class of the kind registry (@mantle/client-types/kinds), the
 *  same set as mantle_kind_class in SQL (access-matrix.db.test.ts). Tasks,
 *  events and Recall maps joined with the registry (workspaces arch A1,
 *  owner decision D1); a journal entry, an email and the other Admin-only
 *  kinds stay Admin. mantle_workspace_kind (0159) still holds the old list
 *  for an unmigrated brain until A7 drops it. */
export const WORKSPACE_NODE_TYPES = kindsWhere<WorkspaceKind>((s) => s.class === 'workspace');

/** What the workspace role may SELECT: nothing, the whole row, or named
 *  columns only. */
export type LimitedRead = 'none' | 'all' | readonly string[];

/**
 * Who writes it: `content` through `db` (writes stay on the system pool with
 * their rule in the statement), `system` through `systemDb` (infrastructure
 * a scoped turn still writes: traces, spills, counters), `admin` only from
 * owner paths.
 */
export type Writer = 'content' | 'system' | 'admin';

export type TableAccess = {
  table: string;
  writer: Writer;
  /**
   * What the workspace role (`mantle_view_user`, workspaces W1) may SELECT.
   * Absent = none. Its row rules are the workspace policies of migration
   * 0242 and after (the row's workspaces meet the scope).
   */
  user?: LimitedRead;
  /** The item table's draft columns too (DRAFT_COLUMNS), next to the named
   *  `user` columns (W6a). */
  drafts?: true;
  /**
   * The workspace role's row rule where it differs (W6a fix round 2).
   * 'own-login': the login's own row, the brain's row, or every row when the
   * scope holds the Admin workspace (profiles, migration 0266).
   */
  userRule?: 'own-login';
  /**
   * What the write role must hold beyond reading the row (migration 0278,
   * mantle_write_check_trg): 'self' (the item table: edit of the item), or
   * the column naming the row's item and edit or manage of that item. A
   * write table with none is read in an Admin scope only (write-role tests
   * pin it).
   */
  writeCheck?: { kind: 'self' } | { kind: 'edit' | 'manage'; item: string };
  /**
   * Columns the database derives (a definer trigger writes them): the write
   * role reads them and never writes them (writeColumnsFor). Needs named
   * `user` columns.
   */
  derived?: readonly string[];
};

/** The draft columns of the item tables. The workspace role reads them since
 *  W6a (plan 14): an Admin user's editor reads the draft, and every reader
 *  asks for it only for an item the user may edit (draftColumn,
 *  draft-read.ts: the rule is in the query). */
export const DRAFT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.pages': ['draft_doc', 'draft_updated_at', 'draft_rev'],
  'public.draws': ['draft_scene', 'draft_updated_at', 'draft_rev'],
  'public.tables': ['draft_data', 'draft_updated_at', 'draft_rev'],
  'public.apps': ['draft_source', 'draft_updated_at', 'draft_build'],
};

/** Columns the workspace role may never read, whatever the matrix says. */
export const NEVER_GRANTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'auth.users': ['password_hash', 'email'],
};

/** What the workspace role may SELECT on `t`. */
export function userReadFor(t: TableAccess): LimitedRead {
  const read = t.user ?? 'none';
  if (!t.drafts) return read;
  if (!Array.isArray(read)) throw new Error(`${t.table}: drafts needs named columns`);
  return [...(read as readonly string[]), ...(DRAFT_COLUMNS[t.table] ?? [])];
}

/** What the write role may INSERT and UPDATE on `t` (a write table): what
 *  the workspace role reads, less the `derived` columns. */
export function writeColumnsFor(t: TableAccess): LimitedRead {
  const read = userReadFor(t);
  if (!t.derived?.length) return read;
  if (!Array.isArray(read)) throw new Error(`${t.table}: derived needs named columns`);
  const cols = read as readonly string[];
  const derived = new Set(t.derived);
  for (const c of derived) {
    if (!cols.includes(c)) throw new Error(`${t.table}: derived column ${c} is not read`);
  }
  return cols.filter((c) => !derived.has(c));
}

const none = (table: string, writer: Writer = 'admin'): TableAccess => ({ table, writer });

/**
 * A table the workspace role reads whole since W6a (an Admin user's screens
 * run in its scope, plan 2.4). Its row rule is in migration 0265: rows that
 * follow an item the scope reads, or (graph, documentation collections)
 * only a scope that holds the Admin workspace.
 */
const userOnly = (table: string, writer: Writer = 'admin'): TableAccess => ({
  table,
  writer,
  user: 'all',
});

export const ACCESS_MATRIX: readonly TableAccess[] = [
  // ── Brain content: what the scope's workspaces hold (0242) ────────────────
  { table: 'public.nodes', user: 'all', writer: 'content', writeCheck: { kind: 'self' } },
  {
    table: 'public.content_chunks',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'node_id' },
  },
  {
    table: 'public.content_chunk_windows',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'node_id' },
  },
  {
    table: 'public.facts',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'source_node_id' },
  },
  {
    table: 'public.pages',
    writeCheck: { kind: 'edit', item: 'node_id' },
    user: ['node_id', 'doc', 'doc_text', 'version', 'created_at', 'updated_at'],
    drafts: true,
    writer: 'content',
  },
  {
    table: 'public.draws',
    writeCheck: { kind: 'edit', item: 'node_id' },
    drafts: true,
    user: [
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
    writer: 'content',
  },
  {
    table: 'public.tables',
    writeCheck: { kind: 'edit', item: 'node_id' },
    drafts: true,
    user: [
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
    writer: 'content',
  },
  // Every column since W6a: an Admin user's app screens read them all;
  // drafts only where the user may edit (draftColumn).
  {
    table: 'public.apps',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'node_id' },
  },
  {
    table: 'public.app_databases',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'app_node_id' },
  },

  // ── Personal spaces (Phase 2; folded into the brain in W6b, 0267) ────────
  // Frozen until W10: read and written on the admin pool only.
  none('public.space_items', 'content'),
  none('public.space_item_bundles', 'content'),
  // Read only through mantle_is_brain_space() (security definer).
  userOnly('public.spaces'),
  // The accepted snapshot a member author reads (0183): the admin pool
  // serves it with the author rule in the query (member-accepted.ts).
  none('public.accepted_snapshots'),
  none('public.space_uploads', 'content'),
  none('public.space_submissions', 'content'),
  none('public.client_comment_ledger', 'content'),

  // ── Configuration the turn loop reads (no per-row secrecy) ────────────────
  // The workspace role (W4b, 0254): an assistant of a workspace in the scope
  // or a helper; tool groups never adminOnly outside Admin, connectors only
  // as a resource of a workspace in the scope.
  { table: 'public.agents', user: 'all', writer: 'admin' },
  { table: 'public.tools', user: 'all', writer: 'admin' },
  { table: 'public.tool_groups', user: 'all', writer: 'admin' },
  { table: 'public.skills', user: 'all', writer: 'admin' },
  { table: 'public.embedding_config', user: 'all', writer: 'admin' },
  { table: 'public.ai_workers', user: 'all', writer: 'admin' },
  // Its own login's row and the brain's, every row only in an Admin scope
  // (0266).
  { table: 'public.profiles', user: 'all', userRule: 'own-login', writer: 'admin' },
  // mantle_brain_id() reads the anchor row; nothing else of a login.
  { table: 'auth.users', user: ['id', 'is_owner', 'created_at'], writer: 'admin' },

  // ── Infrastructure: written through systemDb, never read by a viewer ─────
  userOnly('public.traces', 'system'),
  // Embedding / extraction outages (0230): written by the embedder and the
  // extract queue on the admin pool, read by admin routes only.
  none('public.provider_alerts', 'system'),
  none('public.trace_steps', 'system'),
  // The per-login stores (R3, W4b 0254): the workspace role reads its own
  // login's rows of the workspaces in its scope.
  { ...none('public.tool_results', 'system'), user: 'all' },
  none('public.tool_result_chunks', 'system'),
  { ...none('public.pending_tool_calls', 'system'), user: 'all' },
  none('public.turn_stream_buffer', 'system'),
  none('public.audit_log', 'system'),
  userOnly('public.app_access_log', 'system'),
  none('public.team_access_log', 'system'),
  none('public.member_turn_ledger', 'system'),
  none('public.embedding_cache', 'system'),
  none('public.assistant_read_cursors', 'system'),
  // Per-login pins and opens of the item tree (docs/folder-tree.md). Owner
  // paths only for now; members get their own when the tree reaches them.
  userOnly('public.item_marks', 'admin'),
  none('public.sync_runs', 'system'),
  none('public.maintenance_runs', 'system'),
  none('public.heartbeat_fires', 'system'),
  { ...none('public.runs', 'system'), user: 'all' },
  { ...none('public.run_items', 'system'), user: 'all' },
  // This brain's own id (0226): written once by its migration, read by
  // whoami and the push worker on the admin pool.
  none('public.brain_identity', 'system'),
  none('public.push_instance', 'system'),
  none('public.push_prefs', 'system'),
  none('public.push_subscriptions', 'system'),
  none('public.push_login_prefs', 'system'),
  userOnly('public.shares', 'system'),
  // Contact shares (0214): the /s layer reads and writes these on the admin
  // pool, for the brain. No viewer role ever does.
  none('public.contact_share_codes', 'system'),
  none('public.share_access_log', 'system'),

  // ── Admin only: the private corpus, credentials, the owner's own memory ───
  none('public.api_keys'),
  none('public.secrets'),
  none('public.pdf_passwords'),
  userOnly('public.emails', 'admin'),
  none('public.email_accounts'),
  userOnly('public.email_attachments', 'admin'),
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
  // Inbound API keys (0232): hashes of live secrets, admin pool only.
  none('public.access_keys'),
  none('public.pairing_codes'),
  none('public.member_invites'),
  // The lowering guard's marks and the client request ledger (0197): the
  // tool loop and client_request_create write them as the system.
  none('public.client_sourced_nodes', 'system'),
  none('public.conversation_taints', 'system'),
  none('public.client_request_filings', 'system'),
  none('public.mantle_peers'),
  none('public.peer_shares'),
  none('public.peer_share_scopes'),
  { ...none('public.assistant_messages'), user: 'all' },
  // Chat archive threads (0231): time ranges over assistant_messages, admin pool.
  { ...none('public.chat_threads'), user: 'all' },
  userOnly('public.entities', 'content'),
  userOnly('public.entity_edges', 'content'),
  userOnly('public.entity_merge_dismissals', 'admin'),
  // The embed edges (0208): written by triggers, read on the admin pool.
  none('public.node_embeds', 'content'),
  // Old summaries made before always fold (W2, 0247): admin pool only.
  none('public.node_mixed_summaries', 'content'),
  userOnly('public.recall_maps', 'admin'),
  userOnly('public.recall_nodes', 'admin'),
  // Recall v2: the revision log. Admin pool only, like the other two — the
  // reader filter for a team agent (R6) runs in the tools against the map's
  // node under the viewer, never by opening these tables to a viewer role.
  userOnly('public.recall_revisions', 'admin'),
  // Comments (Phase 2): the admin pool only since W8c.
  none('public.node_comments', 'content'),
  none('public.agent_groups'),
  none('public.channels'),
  none('public.curated_models'),
  none('public.prompt_versions'),
  userOnly('public.node_snapshots', 'admin'),
  userOnly('public.doc_collections', 'admin'),
  none('public.ingest_rules'),
  none('public.saved_filters'),
  none('public.heartbeats'),
  none('public.sandboxes'),
  none('public.app_table_exports'),

  // ── Workspaces (W1, migrations 0241 and 0242) ────────────────────────────
  // The workspace role reads the rows of the workspaces in its scope (and
  // the grants of the items it reads).
  // Every column since W6a (an Admin user's lists read the workspace chips);
  // the row rule (0242) keeps it to the login's workspaces.
  { table: 'public.workspaces', user: 'all', writer: 'admin' },
  { table: 'public.workspace_users', user: 'all', writer: 'admin' },
  {
    table: 'public.workspace_resources',
    writer: 'admin',
    // Never `settings`: a resource's settings may carry configuration the
    // users of the workspace have no business reading (audit L11).
    user: ['id', 'workspace_id', 'type', 'ref_id', 'write'],
  },
  {
    table: 'public.item_grants',
    writeCheck: { kind: 'manage', item: 'node_id' },
    writer: 'content',
    user: ['node_id', 'workspace_id', 'write', 'is_home', 'via_folder_id', 'excluded'],
    // A folder's rows on its items: made by the propagation triggers
    // (definers), never by a login's write (A2b2a fix round 2, M-b).
    derived: ['via_folder_id'],
  },
  // Audit of workspace changes, the heads rows and the heads-check log:
  // admin pool only (the lock functions are security definer).
  none('public.workspace_events'),
  none('public.node_acl_head', 'content'),
  none('public.heads_check_misses', 'system'),
  // The actor-check log (arch A2a, 0275): written by a definer function.
  none('public.actor_check_misses', 'system'),
  // The key the held-heads list is signed with: definer functions only.
  none('public.mantle_heads_key', 'system'),
  // The move triggers' per-transaction list of moved rows: definer only.
  none('public.mantle_moved_nodes', 'system'),
  // The level bridge's per-transaction list of changed nodes (0250).
  none('public.mantle_bridge_pending', 'system'),
  // The tier levels as they were when grants became the truth (0261, W8).
  none('public.archive_node_levels', 'system'),
  // The review tables as they were when the review flows went (0264, W5c),
  // and where each space item goes in W6b (recorded, not granted).
  none('public.archive_space_items', 'system'),
  none('public.archive_space_submissions', 'system'),
  none('public.archive_space_item_bundles', 'system'),
  none('public.private_workspaces', 'system'),
  none('public.former_user_workspaces', 'system'),
  none('public.space_item_homes', 'system'),
  // The personal spaces and their items as they folded into the brain
  // (0267, W6b).
  none('public.archive_spaces', 'system'),
  none('public.space_fold_items', 'system'),
  // A team-portal contact's chat rows (no login) as they were when
  // team_messages folded into assistant_messages (0269, W7c).
  none('public.archive_team_messages', 'system'),
  // The per-login MCP switch (its table dropped in 0273, W8c) and the agent
  // and tool-group levels as they were when every login got one MCP
  // surface, and the credential cutoff for a login with no switch row
  // (0268, W7b).
  none('public.archive_mcp_login_access', 'system'),
  none('public.archive_tool_levels', 'system'),
  none('public.archive_mcp_cutoff', 'system'),
  // The client logins, the email-code sign-in, the static login tokens and
  // the role a key or a peer was made under, as they were when logins
  // stopped carrying anything (0272, W8a). Metadata only. A former client's
  // workspace rows on a brain already on workspaces (W8a fix round 1).
  none('public.archive_client_logins', 'system'),
  none('public.archive_client_workspace_users', 'system'),
  none('public.archive_client_private_workspaces', 'system'),
  none('public.archive_client_signin_codes', 'system'),
  none('public.archive_client_signin_code_skips', 'system'),
  none('public.archive_client_signin_sender_folders', 'system'),
  none('public.archive_mcp_login_tokens', 'system'),
  none('public.archive_key_roles', 'system'),
  none('public.archive_peer_roles', 'system'),
  // The frozen chat and client tables as they were when they were dropped
  // (0274, W8d): the portal read cursors, the member notifications, a
  // login's own chat read cursor, the client report acknowledgements and
  // the client quota log.
  none('public.archive_team_read_cursors', 'system'),
  none('public.archive_team_notifications', 'system'),
  none('public.archive_login_chat_read_cursors', 'system'),
  none('public.archive_client_report_acks', 'system'),
  none('public.archive_client_quota_refusals', 'system'),
];

function quoteTable(table: string): string {
  const [schema, name] = table.split('.');
  return `"${schema}"."${name}"`;
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
 * Whether the write role (`mantle_write_user`, workspaces arch A2b2, plan
 * 20.1) writes `t`: a `content` table that the workspace role reads, so it
 * has a read rule. The write role's row rules ARE that read rule (migration
 * 0278): a row the scope cannot read matches no row. What reading does not
 * decide (edit, manage) is the table's `writeCheck`. A content table with
 * no read rule stays on the system pool and its definer triggers
 * (WRITE_ROLE_SYSTEM_ONLY) until a phase gives it one.
 */
export function writeRoleWrites(t: TableAccess): boolean {
  return t.writer === 'content' && userReadFor(t) !== 'none';
}

/** The tables the write role may INSERT, UPDATE and DELETE. */
export const WRITE_ROLE_TABLES: readonly string[] = ACCESS_MATRIX.filter(writeRoleWrites).map(
  (t) => t.table,
);

/** Content tables the write role may not touch: no read rule, so login
 *  writes to them stay on the system pool (docs/actors.md, "A2b2b must"). */
export const WRITE_ROLE_SYSTEM_ONLY: readonly string[] = ACCESS_MATRIX.filter(
  (t) => t.writer === 'content' && !writeRoleWrites(t),
).map((t) => t.table);

/**
 * Tables a login's write transaction still writes that the write role holds
 * no right on (arch A2b2b), each with where: the login write gateway finds
 * such a transaction by its error (a write-role gap), runs it again whole on
 * the system pool as before A2b2b, and logs it (client.ts). A typed or a
 * single raw write to a table outside WRITE_ROLE_TABLES goes to the system
 * pool up front and is no gap. The test suite fails on a gap that is not
 * here (vitest.setup.ts). A3a gives these tables their checks and moves
 * them; the list then shrinks to nothing.
 */
export const WRITE_ROLE_GAP_TABLES: Readonly<Record<string, string>> = {
  node_snapshots:
    'an item’s history rows, in the transaction of an app publish, restore or delete, a table snapshot (A3a must)',
  recall_maps: 'a Recall map, in the transaction of its Recall node (A3a must)',
  recall_nodes: 'a Recall map’s nodes, with the map (A3a must)',
  recall_revisions: 'a Recall map’s revision log, with the map',
  shares: 'a public link, in the transaction that changes its item (A3a must)',
  secrets: 'a secret’s sealed value, in the transaction of its node (secret_create)',
  app_table_exports: 'an app table’s export row, with the Table it mirrors into',
  profiles: 'a login’s own profile row, made on its first read in a savepoint (profile-preferences.ts)',
};

/**
 * The functions the write role may run beyond the workspace role's (whose
 * rights it mirrors: its policies call them), each with its reason.
 * applyViewerGrants makes the role's rights exactly this, revoking the rest.
 */
export const WRITE_ROLE_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_is_brain_space(uuid)':
    'notify_node_ingested runs with the caller rights on nodes and calls it',
  'public.mantle_lock_heads(uuid[],text)': 'the heads lock the app takes before a write',
  'public.mantle_lock_heads_more(uuid[])': 'more heads inside a transaction that holds some',
  'public.mantle_lock_heads_nested(uuid[],text)': 'the nested heads lock (client.ts, withHeads)',
  'public.mantle_lock_subtree_heads(uuid,uuid[])':
    'a folder’s heads lock (client.ts, withSubtreeHeads): a move, a folder’s grant change',
  'public.mantle_grant_change(text,uuid,uuid,boolean,uuid)':
    'a grant row by the grants panel’s rules (0279): the role never writes the derived columns',
  'public.mantle_grant_move_home(uuid,uuid,boolean,uuid)':
    'a home move in one call (0279): manage of the old home, a Moderator of the new one',
  'public.mantle_workspace_event(uuid,uuid,text,jsonb)':
    'a grant’s audit row (0279): the role holds no right on workspace_events',
};

/** The GRANT statements for the write role. Pure. It reads exactly what the
 *  workspace role reads (its policies name both roles, 0278), and writes the
 *  WRITE_ROLE_TABLES: INSERT and UPDATE on the columns it reads less the
 *  derived ones (writeColumnsFor), DELETE. Sequences: see
 *  applyViewerGrants. */
export function writeGrantStatements(role: string = viewerRoleName('write')): string[] {
  const out = userGrantStatements(role);
  for (const t of ACCESS_MATRIX.filter(writeRoleWrites)) {
    const write = writeColumnsFor(t);
    if (write === 'none') continue;
    const cols = write === 'all' ? '' : ` (${write.map((c) => `"${c}"`).join(', ')})`;
    out.push(`GRANT INSERT${cols}, UPDATE${cols}, DELETE ON ${quoteTable(t.table)} TO "${role}"`);
  }
  return out;
}

/** The write check's arguments for `t` (mantle_write_check_trg), or null. */
export function writeCheckArgs(t: TableAccess): string[] | null {
  if (!writeRoleWrites(t) || !t.writeCheck) return null;
  return t.writeCheck.kind === 'self' ? ['self'] : [t.writeCheck.kind, t.writeCheck.item];
}

/**
 * Make the live grants equal the matrix: revoke everything the workspace
 * role and the write role hold on every table (and the write role on every
 * sequence), then grant what the matrix lists. The write role's function
 * rights become exactly the workspace role's plus WRITE_ROLE_FUNCTIONS. The
 * retired roles (RETIRED_POOL_ROLES) lose every table, sequence and function
 * right and their schema usage, so an old migration run on a fresh install
 * (its grants to the level roles) leaves them nothing. One transaction,
 * idempotent; migrate runs it after the migrations. Then the write role's
 * row rules, table by table (syncWriteRoleRules).
 */
export async function applyViewerGrants(sql: ReturnType<typeof postgres>): Promise<void> {
  const live = POOL_ROLES.map((r) => `"${viewerRoleName(r)}"`).join(', ');
  const retired = RETIRED_POOL_ROLES.map((r) => `"${viewerRoleName(r)}"`).join(', ');
  const writer = `"${viewerRoleName('write')}"`;
  // Retried on "tuple concurrently updated": two processes granting on the
  // same objects at once (parallel test files do).
  await withRoleRetry(() =>
    sql.begin(async (tx) => {
      await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${live}, ${retired}`);
      await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM ${live}, ${retired}`);
      await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, auth FROM ${retired}`);
      await tx.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, auth FROM ${retired}`);
      await tx.unsafe(`REVOKE ALL ON SCHEMA public, auth FROM ${retired}`);
      await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, auth FROM ${writer}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA public, auth TO ${live}`);
      for (const stmt of userGrantStatements()) await tx.unsafe(stmt);
      for (const stmt of writeGrantStatements()) await tx.unsafe(stmt);
      // The sequences a write to those tables draws from (a serial or
      // identity column), read from the catalog.
      const seqs = await tx<{ seq: string }[]>`
      select distinct quote_ident(sn.nspname) || '.' || quote_ident(s.relname) as seq
        from pg_depend d
        join pg_class s on s.oid = d.objid and s.relkind = 'S'
        join pg_namespace sn on sn.oid = s.relnamespace
        join pg_class t on t.oid = d.refobjid
        join pg_namespace tn on tn.oid = t.relnamespace
       where d.deptype in ('a', 'i')
         and tn.nspname || '.' || t.relname = any(${WRITE_ROLE_TABLES as string[]}::text[])
       order by 1`;
      for (const { seq } of seqs) await tx.unsafe(`GRANT USAGE ON SEQUENCE ${seq} TO ${writer}`);
      // Function rights: the workspace role's and WRITE_ROLE_FUNCTIONS,
      // exactly (a right no longer wanted is revoked). Functions that do not
      // exist yet (a database migrated part way) are left out.
      const fns = await tx<{ fn: string; has: boolean; want: boolean }[]>`
      with named as (
        select to_regprocedure(n) as oid from unnest(${Object.keys(WRITE_ROLE_FUNCTIONS)}::text[]) n
      ),
      viewer as (
        select p.oid from pg_proc p cross join lateral aclexplode(p.proacl) a
         where a.grantee = to_regrole('mantle_view_user') and a.privilege_type = 'EXECUTE'
      ),
      writer as (
        select p.oid from pg_proc p cross join lateral aclexplode(p.proacl) a
         where a.grantee = to_regrole('mantle_write_user') and a.privilege_type = 'EXECUTE'
      ),
      every as (
        select oid from named where oid is not null
        union select oid from viewer union select oid from writer
      )
      select e.oid::regprocedure::text as fn,
             e.oid in (select oid from writer) as has,
             e.oid in (select oid from viewer union select oid from named) as want
        from every e`;
      for (const f of fns) {
        if (f.want && !f.has) await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${f.fn} TO ${writer}`);
        if (!f.want && f.has) await tx.unsafe(`REVOKE EXECUTE ON FUNCTION ${f.fn} FROM ${writer}`);
      }
    }),
  );
  await syncWriteRoleRules(sql);
}

/** Errors a short policy change may meet on a busy box: a lock it waited
 *  for too long (lock_timeout) or a deadlock with live traffic. */
const RETRY_CODES = new Set(['55P03', '40P01']);

/**
 * The write role's row rules and write checks (mantle_write_role_sync_table,
 * 0278), one table per transaction: every write table, every table with a
 * read rule of the workspace role, and every table that still carries a
 * rule or check of the write role (the matrix's schemas, public and auth). Each waits at most 3 s for its lock and
 * is tried again (8 times, 1 s apart): a policy change takes its table's
 * ACCESS EXCLUSIVE lock, so it must be short. A table whose rules match
 * takes no lock. A database migrated part way (no sync function yet) is
 * left as it is.
 */
export async function syncWriteRoleRules(sql: ReturnType<typeof postgres>): Promise<void> {
  const [ready] = await sql<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_write_role_sync_table(text,boolean,text[])') is not null as ok`;
  if (!ready?.ok) return;
  const byTable = new Map(ACCESS_MATRIX.map((t) => [t.table, t]));
  const others = await sql<{ t: string }[]>`
    select distinct schemaname || '.' || tablename as t from pg_policies
     where roles && array['mantle_view_user', 'mantle_write_user']::name[]
       and schemaname in ('public', 'auth')
    union
    select distinct n.nspname || '.' || c.relname from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where tg.tgname = 'mantle_write_check' and n.nspname in ('public', 'auth')`;
  const tables = [...new Set([...WRITE_ROLE_TABLES, ...others.map((r) => r.t)])].sort();
  for (const table of tables) {
    const t = byTable.get(table);
    const write = t ? writeRoleWrites(t) : false;
    const args = t ? writeCheckArgs(t) : null;
    for (let attempt = 1; ; attempt++) {
      try {
        await withRoleRetry(() =>
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout = '3s'`);
            await tx`select mantle_write_role_sync_table(${table}, ${write}, ${args}::text[])`;
          }),
        );
        break;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (attempt >= 8 || !RETRY_CODES.has(code)) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
