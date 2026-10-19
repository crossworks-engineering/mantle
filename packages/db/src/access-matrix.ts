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
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { LOCK_ATTRS, POOL_ROLES, RETIRED_POOL_ROLES, withRoleRetry } from './viewer-roles';
import { viewerRoleName } from './viewer';
import { kindsWhere, type WorkspaceKind } from '@mantle/client-types/kinds';

/** The node types that may be granted beyond the Admin workspace: the
 *  'workspace' class of the kind registry (@mantle/client-types/kinds), the
 *  same set as mantle_kind_class in SQL (access-matrix.db.test.ts). Tasks,
 *  events and Recall maps joined with the registry (workspaces arch A1,
 *  owner decision D1); a journal entry, an email and the other Admin-only
 *  kinds stay Admin. The old list (mantle_workspace_kind, 0159) went at
 *  arch A7 (0295). */
export const WORKSPACE_NODE_TYPES = kindsWhere<WorkspaceKind>((s) => s.class === 'workspace');

/** What the workspace role may SELECT: nothing, the whole row, or named
 *  columns only. */
export type LimitedRead = 'none' | 'all' | readonly string[];

/**
 * Who writes it: `content` through `db` (a login's scoped write runs on the
 * write role, where the database checks it; a system actor's on the system
 * pool, and so does every write while the actor check is off, and a login's
 * to the content tables of WRITE_ROLE_SYSTEM_ONLY, which the write role may
 * not touch), `system` through `systemDb` (infrastructure a scoped turn
 * still writes: traces, spills, counters), `admin` only from owner paths.
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
   * The write role's write rule where it is narrower than the read rule
   * (plan v3 S3; mantle_write_role_sync_table's write_rule, migration
   * S3's). 'own-login' (profiles, owner decision 2026-10-17): the login's
   * own row, or the brain's row when the scope's login holds the Settings
   * area (mantle_scope_has_area). Never another login's row. Absent: the
   * write rule is the read rule.
   */
  writeRule?: 'own-login';
  /**
   * What the write role must hold beyond reading the row (migration 0278,
   * mantle_write_check_trg): 'self' (the item table: edit of the item), or
   * the column naming the row's item and edit or manage of that item. A
   * write table with none is read in an Admin scope only (write-role tests
   * pin it).
   */
  writeCheck?: { kind: 'self' } | { kind: 'edit' | 'manage'; item: string };
  /**
   * What the write role must hold beyond the write check, per operation and
   * column (workspaces arch A3a, plan 5.2), behind mantle.edit_check: off
   * runs, warn reports, on refuses (docs/edit-check.md). Migrate makes the
   * triggers (mantle_edit_check_trg, migration 0281) from it:
   * editCheckTriggers.
   */
  editCheck?: EditCheck;
  /**
   * Columns the database derives (a definer trigger writes them): the write
   * role reads them and never writes them (writeColumnsFor). Needs named
   * `user` columns.
   */
  derived?: readonly string[];
  /**
   * 'none': the runtime role (mantle_runtime, arch A9) holds no right on it
   * either: only definer functions touch it (runtime-role.ts). Absent = the
   * runtime role reads and writes it, as the system pool always has.
   */
  runtime?: 'none';
};

/**
 * What an operation on a row asks of the row's item (mantle_check_row,
 * migration 0280): edit (a Moderator of its home, or a grant with Write
 * on), manage (a Moderator of its home), admin (the scope holds the Admin
 * workspace: an Admin user), appdata (an app's data: edit, and while the app
 * is Informational an Admin scope too, owner decision D6), link (a public
 * link: edit, an app's manage) or link_close (a link closed: link, or an
 * Admin user with the users area). 'system': only the brain writes it.
 */
export type EditNeed = 'edit' | 'manage' | 'admin' | 'appdata' | 'link' | 'link_close';

/** A table's A3a checks (TableAccess.editCheck). Only what the write check
 *  (writeCheck, 0278) does not already ask. */
export type EditCheck = {
  /** The column naming the row's item (a node id), or 'self' on nodes. */
  item: string;
  /** The table that names the item: a Recall card's or revision's map_id
   *  is a recall_maps id, whose node_id is the item. */
  via?: 'recall_maps';
  insert?: EditNeed;
  update?: EditNeed;
  delete?: EditNeed;
  /** UPDATE: a change to one of these columns needs this. 'rest': every
   *  column of the table (read from the catalog at migrate, so a column a
   *  later migration adds is in it: deny by default) not named in another
   *  group or in `free`. */
  columns?: Partial<Record<EditNeed | 'system', readonly string[] | 'rest'>>;
  /** Columns a change of which needs nothing more than the operation's
   *  need (kept out of 'rest'). */
  free?: readonly string[];
  /** A column whose change TO this value needs nothing more (a narrowing:
   *  an app lowered to team level, an embedding cleared). On INSERT, a
   *  value other than this needs its group's need (not for 'system'). */
  safe?: Readonly<Record<string, string | boolean | null>>;
  /** nodes: the keys of mantle_node_derived_keys() in data are the brain's:
   *  a write may clear one, never set or change one. */
  derivedKeys?: true;
  /** shares: a row with a contact_id (a contact share) needs admin instead
   *  of the operation's or column's need (the guide: "Share it with one
   *  contact: to be an Admin user, its home is not checked"). */
  contactAdmin?: true;
};

/** The draft columns of the item tables. The workspace role reads them since
 *  W6a (plan 14): an Admin user's editor reads the draft, and every reader
 *  asks for it only for an item the user may edit (draftColumn,
 *  draft-read.ts: the rule is in the query). */
export const DRAFT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.pages': ['draft_doc', 'draft_updated_at', 'draft_rev'],
  'public.draws': ['draft_scene', 'draft_updated_at', 'draft_rev'],
  'public.tables': ['draft_data', 'draft_updated_at', 'draft_rev', 'draft_path'],
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

/** The nodes columns a login's edit changes (A3a): the write check asks
 *  edit of each change, the guards keep the derived ones (home_ws,
 *  read_ws, write_ws, login_id) and a kind never changes on the role. Every
 *  other column is the brain's (editCheck 'rest'). */
export const NODE_EDIT_COLUMNS: readonly string[] = [
  'title',
  'slug',
  'data',
  'path',
  'parent_id',
  'tags',
  'type',
  'salience',
  'superseded_by',
  'superseded_reason',
  'updated_at',
  'home_ws',
  'read_ws',
  'write_ws',
  'login_id',
];

/** An app's code (owner decision D4: a Moderator of its home changes it). */
export const APP_CODE_COLUMNS: readonly string[] = [
  'source',
  'source_text',
  'draft_source',
  'draft_updated_at',
  'manifest',
  'draft_build',
  'published_build',
  'version',
  'restored_from_seq',
];

/** An app's switches and author (owner decision D5: Admin users only):
 *  trust its tools (author_level), MCP access, data read only
 *  (Informational), and who made it. */
export const APP_SWITCH_COLUMNS: readonly string[] = [
  'author_level',
  'author_ceiling_seen',
  'mcp_access',
  'data_read_only',
  'author_login_id',
];

export const ACCESS_MATRIX: readonly TableAccess[] = [
  // ── Brain content: what the scope's workspaces hold (0242) ────────────────
  {
    table: 'public.nodes',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'self' },
    // A3a: the columns an edit changes (the write check asks edit; the
    // guards keep the derived ones); every other column is the brain's
    // (deny by default), an embedding only cleared; the derived keys of
    // data only cleared.
    editCheck: {
      item: 'self',
      free: NODE_EDIT_COLUMNS,
      columns: { system: 'rest' },
      safe: { embedding: null },
      derivedKeys: true,
    },
  },
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
    editCheck: { item: 'node_id', delete: 'manage' },
    user: ['node_id', 'doc', 'doc_text', 'version', 'created_at', 'updated_at'],
    drafts: true,
    writer: 'content',
  },
  {
    table: 'public.draws',
    writeCheck: { kind: 'edit', item: 'node_id' },
    editCheck: { item: 'node_id', delete: 'manage' },
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
    editCheck: { item: 'node_id', delete: 'manage' },
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
  // A3a: the code needs manage (owner decision D4: a Moderator of the
  // app's home), the three switches and the author need an Admin user (D5);
  // lowering the tool level to team is always allowed.
  {
    table: 'public.apps',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'node_id' },
    editCheck: {
      item: 'node_id',
      insert: 'manage',
      delete: 'manage',
      columns: { manage: APP_CODE_COLUMNS, admin: APP_SWITCH_COLUMNS },
      safe: {
        author_level: 'team',
        author_ceiling_seen: true,
        mcp_access: false,
        data_read_only: false,
      },
    },
  },
  // A3a: an app's data (D6: while Informational is on, Admin users only).
  {
    table: 'public.app_databases',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'edit', item: 'app_node_id' },
    editCheck: { item: 'app_node_id', insert: 'appdata', update: 'appdata', delete: 'manage' },
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
  // The snapshot store's tombstones (A3b part 2, 0284): written by definer
  // triggers, read and cleared by the store sweep on the system pool.
  none('public.store_tombstones'),
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
  // Read: its own login's row and the brain's, every row only in an Admin
  // scope (0266). Write (plan v3 S3, owner decision 2026-10-17): its own
  // row, and the brain's only for a login whose scope holds the Settings
  // area; a member's turn never changes the brain's row.
  {
    table: 'public.profiles',
    user: 'all',
    userRule: 'own-login',
    writeRule: 'own-login',
    writer: 'content',
  },
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
  // A public link (A3a, plan 5.2): edit of its item, an app's manage;
  // closing it (revoked_at, or the row deleted) also an Admin user with the
  // users area. Its view counter is the brain's (a named read-path write).
  {
    table: 'public.shares',
    user: 'all',
    writer: 'content',
    editCheck: {
      item: 'node_id',
      insert: 'link',
      delete: 'link_close',
      columns: { link_close: ['revoked_at'], link: 'rest' },
      contactAdmin: true,
    },
  },
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
  // A Recall map follows its node; its cards and its revision log follow the
  // map (A3a: the write role writes them, edit of the map's node; a map
  // deleted, manage). A renamed map's cross-map options in other maps are
  // the brain's (mantle_recall_retarget, 0281).
  {
    table: 'public.recall_maps',
    user: 'all',
    writer: 'content',
    editCheck: { item: 'node_id', insert: 'edit', update: 'edit', delete: 'manage' },
  },
  {
    table: 'public.recall_nodes',
    user: 'all',
    writer: 'content',
    editCheck: {
      item: 'map_id',
      via: 'recall_maps',
      insert: 'edit',
      update: 'edit',
      delete: 'edit',
    },
  },
  {
    table: 'public.recall_revisions',
    user: 'all',
    writer: 'content',
    editCheck: {
      item: 'map_id',
      via: 'recall_maps',
      insert: 'edit',
      update: 'edit',
      delete: 'edit',
    },
  },
  // Comments (Phase 2): the admin pool only since W8c.
  none('public.node_comments', 'content'),
  none('public.agent_groups'),
  none('public.channels'),
  none('public.curated_models'),
  none('public.prompt_versions'),
  // An item's history (app versions and snapshots, table snapshots), A3a:
  // edit of the item, on the write role while the item lives (its row rule
  // follows the node). A deleted app's rows are the brain's (app-trash):
  // the route asks manage of the stored home, the owner for one another
  // login deleted (docs/edit-check.md).
  {
    table: 'public.node_snapshots',
    user: 'all',
    writer: 'content',
    editCheck: { item: 'node_id', insert: 'edit', update: 'edit', delete: 'edit' },
  },
  userOnly('public.doc_collections', 'admin'),
  none('public.ingest_rules'),
  none('public.saved_filters'),
  none('public.heartbeats'),
  none('public.sandboxes'),
  // An app table's export row (plan v3 S3): read and written on the
  // write role by a manager of the app (its row rule, S3's migration, and
  // the write check), as the export tools ask; the dirty stamp and the
  // sync stay the brain's named system step. The edit check asks edit of
  // the linked Table too (fix round 3, defense in depth): a link made or
  // moved by a scope points only at a Table it may change, since the sync
  // rewrites that Table's grid as the brain.
  {
    table: 'public.app_table_exports',
    user: 'all',
    writer: 'content',
    writeCheck: { kind: 'manage', item: 'app_node_id' },
    editCheck: { item: 'table_node_id', insert: 'edit', update: 'edit' },
  },

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
  { ...none('public.mantle_heads_key', 'system'), runtime: 'none' },
  // The move triggers' per-transaction list of moved rows: definer only.
  { ...none('public.mantle_moved_nodes', 'system'), runtime: 'none' },
  // The level bridge's per-transaction list of changed nodes (0250).
  { ...none('public.mantle_bridge_pending', 'system'), runtime: 'none' },
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

/** Whether a table's column exists now: grants name only those (a test
 *  database migrated up to an older migration lacks a newer column, A3b). */
export type ColumnExists = (table: string, column: string) => boolean;

/**
 * The matrix columns a database may still lack while it migrates (a test's
 * scratch database migrated up to an older migration, or a box between the
 * grants and the migration that adds them): the grants skip ONLY these when
 * they are missing, each one logged. Any other matrix column the database
 * lacks is an error, as a GRANT naming it would be (A3b fix round 1, L4).
 */
export const COLUMNS_ADDED_LATE: Readonly<Record<string, readonly string[]>> = {
  'public.tables': ['draft_path'], // 0283
};

/** The grants' column filter over the columns that exist (`present`, as
 *  `<schema>.<table>.<column>`): a missing late column is skipped and
 *  logged, any other missing one throws. */
export function grantColumnFilter(
  present: ReadonlySet<string>,
  log: (message: string) => void = console.warn,
): ColumnExists {
  const logged = new Set<string>();
  return (table, column) => {
    if (present.has(`${table}.${column}`)) return true;
    const key = `${table}.${column}`;
    if (!(COLUMNS_ADDED_LATE[table] ?? []).includes(column)) {
      throw new Error(
        `the access matrix names ${key}, which this database lacks: migrate it first`,
      );
    }
    if (!logged.has(key)) {
      logged.add(key);
      log(`[access-matrix] ${key} is not in this database yet: its grant is skipped`);
    }
    return false;
  };
}

/** The GRANT statements for the workspace role (`mantle_view_user`). Pure. */

export function userGrantStatements(
  role: string = viewerRoleName('user'),
  has: ColumnExists = () => true,
): string[] {
  const out: string[] = [];
  for (const t of ACCESS_MATRIX) {
    const read = userReadFor(t);
    if (read === 'none') continue;
    const named = read === 'all' ? null : read.filter((c) => has(t.table, c));
    if (named && named.length === 0) continue;
    const cols = named === null ? '' : ` (${named.map((c) => `"${c}"`).join(', ')})`;
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
 * The role the gap rerun ran a gap table's statement as (A2b2b fix round 2,
 * L2). Plan v3 S3 closed the gap tables (profiles and app_table_exports are
 * write-role tables) and deleted the rerun: nothing runs as it, and
 * applyViewerGrants keeps it holding no right at all (syncGapWriterRights).
 * TODO(plan v3 S3 part 2, one release later): drop the role, its runtime
 * role membership (runtime-role.ts wantedMemberships) and the lock
 * attributes it shares with the viewer roles (viewer-roles.ts).
 */
export const GAP_WRITER_ROLE = 'mantle_gap_writer';

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
  'public.mantle_recall_retarget(uuid,text,text)':
    'a renamed Recall map’s cross-map options in every map (0281): the brain’s references',
  'public.mantle_secret_put(uuid,bytea,integer)':
    'a secret’s sealed value (0281): the role holds no right on secrets',
  'public.mantle_subtree_rewrite(uuid,ltree,ltree)':
    'a folder’s rename or move (0282): every row below it, those the scope does not read too',
  'public.mantle_subtree_refuse_hidden(uuid,ltree)':
    'a folder move or delete refused when it holds rows the scope does not read (0282, the 409)',
  'public.mantle_read_cursor_mark(uuid,uuid,uuid,timestamp with time zone)':
    'the login’s own chat read cursor (0293): the role holds no right on assistant_read_cursors',
  'public.mantle_access_key_revoke(uuid,uuid)':
    'the login’s own API key revoked, any for an Admin user (0293): the role holds no right on access_keys',
  'public.mantle_ws_create(uuid,uuid,text,text)':
    'a workspace the login makes, its only user a Moderator (0293): the role holds no right on workspaces',
  'public.mantle_ws_add_user(uuid,uuid,uuid,boolean)':
    'a user added to a workspace by the acting login (0307, S2a a1): the role holds no right on workspace_users',
  'public.mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text)':
    'a Moderator tick set or cleared by the acting login (0307, S2a a1)',
  'public.mantle_ws_remove_user(uuid,uuid,uuid)':
    'a user removed from a workspace, or leaving it, by the acting login (0307, S2a a1)',
  'public.mantle_ws_resource_add(uuid,uuid,text,text,boolean)':
    'a connector or the assistant added by the acting login (0307, S2a a2): the role holds no right on workspace_resources',
  'public.mantle_ws_resource_set_write(uuid,uuid,text,text,boolean)':
    'a connector’s Write tick set by the acting login (0307, S2a a2)',
  'public.mantle_ws_resource_remove(uuid,uuid,text,text)':
    'a connector or the assistant taken off by the acting login (0307, S2a a2)',
  'public.mantle_ws_set_assistant(uuid,uuid,uuid)':
    'the workspace’s assistant set or cleared by the acting login (0307, S2a a2)',
  'public.mantle_ws_update_about(uuid,uuid,jsonb)':
    'a workspace’s name, description and look changed by the acting login (0309, S2b): the role holds no right on workspaces',
  'public.mantle_ws_set_contact(uuid,uuid,uuid)':
    'a workspace’s contact set or cleared by the acting login (0309, S2b)',
  'public.mantle_ws_set_landing(uuid,uuid,uuid)':
    'a workspace’s landing app set or cleared by the acting login (0309, S2b)',
};

/** The GRANT statements for the write role. Pure. It reads exactly what the
 *  workspace role reads (its policies name both roles, 0278), and writes the
 *  WRITE_ROLE_TABLES: INSERT and UPDATE on the columns it reads less the
 *  derived ones (writeColumnsFor), DELETE. Sequences: see
 *  applyViewerGrants. */
export function writeGrantStatements(
  role: string = viewerRoleName('write'),
  has: ColumnExists = () => true,
): string[] {
  const out = userGrantStatements(role, has);
  for (const t of ACCESS_MATRIX.filter(writeRoleWrites)) {
    const write = writeColumnsFor(t);
    if (write === 'none') continue;
    const named = write === 'all' ? null : write.filter((c) => has(t.table, c));
    if (named && named.length === 0) continue;
    const cols = named === null ? '' : ` (${named.map((c) => `"${c}"`).join(', ')})`;
    out.push(`GRANT INSERT${cols}, UPDATE${cols}, DELETE ON ${quoteTable(t.table)} TO "${role}"`);
  }
  return out;
}

/** The write role's write rule key for `t` (TableAccess.writeRule), or
 *  null for its read rule. */
export function writeRuleArg(t: TableAccess): string | null {
  return writeRoleWrites(t) ? (t.writeRule ?? null) : null;
}

/** The write check's arguments for `t` (mantle_write_check_trg), or null. */
export function writeCheckArgs(t: TableAccess): string[] | null {
  if (!writeRoleWrites(t) || !t.writeCheck) return null;
  return t.writeCheck.kind === 'self' ? ['self'] : [t.writeCheck.kind, t.writeCheck.item];
}

/** One trigger of a table's A3a checks: its name and its CREATE statement. */
export type EditCheckTrigger = { name: string; ddl: string };

/** The read-only refusal (0280): one per item table, made by its migration,
 *  never by editCheckTriggers. */
export const EDIT_CHECK_RO_TRIGGER = 'mantle_edit_check_ro';

/** A contact share writes its app's data only (0294, A8 matrix F9): one per
 *  item table but app_databases and node_acl_head, made by its migration,
 *  never by editCheckTriggers. */
export const EDIT_CHECK_CONTACT_TRIGGER = 'mantle_edit_check_contact';

/** The edit check's triggers its migrations make (of the family's name, so
 *  mantle_set_edit_check switches them with the rest): migrate's sync of
 *  the matrix-made ones leaves them alone, and the matrix may not use the
 *  names. */
export const EDIT_CHECK_MIGRATION_TRIGGERS: readonly string[] = [
  EDIT_CHECK_RO_TRIGGER,
  EDIT_CHECK_CONTACT_TRIGGER,
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
const EDIT_NEEDS: ReadonlySet<string> = new Set([
  'edit',
  'manage',
  'admin',
  'appdata',
  'link',
  'link_close',
  'system',
]);

function ident(c: string, where: string): string {
  if (!IDENT.test(c)) throw new Error(`${where}: not a column name: ${c}`);
  return `"${c}"`;
}

function safeLiteral(v: string | boolean | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (!/^[a-z0-9_]{1,40}$/i.test(v)) throw new Error(`editCheck: not a safe value: ${v}`);
  return `'${v}'`;
}

/**
 * The triggers of `t`'s A3a checks (TableAccess.editCheck), given the
 * table's columns as the catalog has them (not dropped, not generated) and
 * those whose type lives outside pg_catalog (`textCompare`: a vector, an
 * ltree), which the WHEN compares as text: a restore runs with an empty
 * search_path, where `vector = vector` is not found (the 0204 lesson;
 * dump-restore.db.test.ts). Pure. Each fires for the write role only, BEFORE the row's write, and
 * calls mantle_edit_check_trg(need, item, via, mode):
 *  - mantle_edit_check_<need>: the operations that need it;
 *  - mantle_edit_check_cols_<need>: an UPDATE of one of its columns (the
 *    trigger's WHEN: a change, not to the column's safe value);
 *  - mantle_edit_check_ins_<need>: an INSERT that sets one of its columns
 *    to something other than the safe value (not for 'system');
 *  - mantle_edit_check_keys: an UPDATE of nodes.data (the derived keys).
 * The edit check's switch (mantle_set_edit_check) enables or disables every
 * trigger named mantle_edit_check_*.
 */
export function editCheckTriggers(
  t: TableAccess,
  columns: readonly string[],
  textCompare: ReadonlySet<string> = new Set(),
): EditCheckTrigger[] {
  const e = t.editCheck;
  if (!e || !writeRoleWrites(t)) return [];
  const where = `editCheck of ${t.table}`;
  if (e.item !== 'self') ident(e.item, where);
  const table = quoteTable(t.table);
  const when = `current_user = 'mantle_write_user'`;
  const rowMode = e.contactAdmin ? 'contact' : '';
  const fn = (need: string, mode = rowMode) => {
    if (!EDIT_NEEDS.has(need)) throw new Error(`${where}: unknown need ${need}`);
    return `EXECUTE FUNCTION "public"."mantle_edit_check_trg"('${need}', '${e.item}', '${e.via ?? ''}', '${mode}')`;
  };
  const have = new Set(columns);
  const named = (c: string) => {
    if (!have.has(c)) throw new Error(`${where}: no column ${c} (or it is generated)`);
    return c;
  };
  const out: EditCheckTrigger[] = [];

  // The operations, one trigger per need.
  const byNeed = new Map<string, string[]>();
  for (const op of ['insert', 'update', 'delete'] as const) {
    const need = e[op];
    if (need) byNeed.set(need, [...(byNeed.get(need) ?? []), op.toUpperCase()]);
  }
  for (const [need, ops] of byNeed) {
    out.push({
      name: `mantle_edit_check_${need}`,
      ddl:
        `CREATE TRIGGER "mantle_edit_check_${need}" BEFORE ${ops.join(' OR ')} ON ${table} ` +
        `FOR EACH ROW WHEN (${when}) ${fn(need)}`,
    });
  }

  // The column groups.
  const groups = Object.entries(e.columns ?? {}) as [string, readonly string[] | 'rest'][];
  const listed = new Set<string>([...(e.free ?? []).map(named)]);
  for (const [, cols] of groups) if (cols !== 'rest') for (const c of cols) listed.add(named(c));
  const safe = e.safe ?? {};
  for (const c of Object.keys(safe)) named(c);
  for (const [need, spec] of groups) {
    const cols =
      spec === 'rest' ? columns.filter((c) => !listed.has(c)) : spec.map((c) => named(c));
    if (cols.length === 0) continue;
    const changed = cols.map((c) => {
      const q = ident(c, where);
      const cast = textCompare.has(c) ? '::text' : '';
      const differs = `OLD.${q}${cast} IS DISTINCT FROM NEW.${q}${cast}`;
      if (!Object.hasOwn(safe, c)) return differs;
      // The safe value first, so a write that sets it (an embedding
      // cleared) never compares the old value.
      const v = safe[c]!;
      return v === null
        ? `(NEW.${q} IS NOT NULL AND ${differs})`
        : `(NEW.${q}${cast} IS DISTINCT FROM ${safeLiteral(v)} AND ${differs})`;
    });
    out.push({
      name: `mantle_edit_check_cols_${need}`,
      ddl:
        `CREATE TRIGGER "mantle_edit_check_cols_${need}" BEFORE UPDATE OF ` +
        `${cols.map((c) => ident(c, where)).join(', ')} ON ${table} ` +
        `FOR EACH ROW WHEN (${when} AND (${changed.join(' OR ')})) ${fn(need)}`,
    });
    const insertSafe = need === 'system' ? [] : cols.filter((c) => Object.hasOwn(safe, c));
    if (insertSafe.length > 0) {
      out.push({
        name: `mantle_edit_check_ins_${need}`,
        ddl:
          `CREATE TRIGGER "mantle_edit_check_ins_${need}" BEFORE INSERT ON ${table} ` +
          `FOR EACH ROW WHEN (${when} AND (${insertSafe
            .map((c) =>
              safe[c] === null
                ? `NEW.${ident(c, where)} IS NOT NULL`
                : `NEW.${ident(c, where)}${textCompare.has(c) ? '::text' : ''} IS DISTINCT FROM ${safeLiteral(safe[c]!)}`,
            )
            .join(' OR ')})) ${fn(need)}`,
      });
    }
  }

  if (e.derivedKeys) {
    if (e.item !== 'self') throw new Error(`${where}: derivedKeys is for nodes`);
    named('data');
    // A new node that carries values only the brain sets: the derived keys,
    // and the brain's columns whose safe value is null (an embedding). On,
    // they are dropped (the extractor writes them again); warn reports.
    const strip = Object.keys(safe).filter((c) => safe[c] === null);
    for (const c of strip) ident(c, where);
    out.push({
      name: 'mantle_edit_check_ins_keys',
      ddl:
        `CREATE TRIGGER "mantle_edit_check_ins_keys" BEFORE INSERT ON ${table} ` +
        `FOR EACH ROW WHEN (${when} AND (coalesce(NEW."data", '{}'::jsonb) ?| "public"."mantle_node_derived_keys"()` +
        `${strip.map((c) => ` OR NEW.${ident(c, where)} IS NOT NULL`).join('')})) ` +
        fn('edit', `strip:${strip.join(',')}`),
    });
    out.push({
      name: 'mantle_edit_check_keys',
      ddl:
        `CREATE TRIGGER "mantle_edit_check_keys" BEFORE UPDATE OF "data" ON ${table} ` +
        `FOR EACH ROW WHEN (${when} AND OLD."data" IS DISTINCT FROM NEW."data") ${fn('edit', 'keys')}`,
    });
  }
  for (const x of out) {
    if (EDIT_CHECK_MIGRATION_TRIGGERS.includes(x.name)) {
      throw new Error(`${where}: ${x.name} is reserved`);
    }
  }
  return out;
}

/** The note a matrix-made edit check trigger carries (COMMENT ON TRIGGER):
 *  its statement's hash, so a migrate that changes nothing changes no
 *  trigger. */
export function editCheckNote(ddl: string): string {
  return `mantle:edit-check:${createHash('sha256').update(ddl).digest('hex').slice(0, 24)}`;
}

/**
 * Bring one table's A3a triggers to the matrix (editCheckTriggers), inside
 * the caller's transaction (syncWriteRoleRules: lock_timeout 3 s): drop a
 * matrix-made trigger the matrix no longer wants or that changed, make the
 * missing ones, each disabled when the box's edit check is off (so off
 * costs nothing). A table whose triggers match takes no lock. A database
 * before 0281 is left as it is.
 */
async function syncEditChecks(
  tx: postgres.TransactionSql,
  table: string,
  t: TableAccess | undefined,
  write: boolean,
): Promise<void> {
  const [ready] = await tx<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_edit_check_trg()') is not null
       and to_regclass(${table}) is not null as ok`;
  if (!ready?.ok) return;
  const cols = await tx<{ c: string; text: boolean }[]>`
    select a.attname::text as c, tn.nspname <> 'pg_catalog' as text
      from pg_attribute a
      join pg_type ty on ty.oid = a.atttypid
      join pg_namespace tn on tn.oid = ty.typnamespace
     where a.attrelid = ${table}::regclass and a.attnum > 0 and not a.attisdropped
       and a.attgenerated = '' order by a.attnum`;
  const want =
    t && write
      ? editCheckTriggers(
          t,
          cols.map((r) => r.c),
          new Set(cols.filter((r) => r.text).map((r) => r.c)),
        )
      : [];
  const have = await tx<{ name: string; note: string }[]>`
    select tg.tgname::text as name, coalesce(obj_description(tg.oid, 'pg_trigger'), '') as note
      from pg_trigger tg
     where tg.tgrelid = ${table}::regclass and not tg.tgisinternal
       and (tg.tgname = 'mantle_edit_check' or tg.tgname like 'mantle\\_edit\\_check\\_%')
       and tg.tgname::text <> all(${[...EDIT_CHECK_MIGRATION_TRIGGERS]}::text[])`;
  const wanted = new Map(want.map((w) => [w.name, w]));
  const rel = quoteTable(table);
  let off: boolean | null = null;
  for (const h of have) {
    const w = wanted.get(h.name);
    if (w && h.note === editCheckNote(w.ddl)) {
      wanted.delete(h.name);
      continue;
    }
    await tx.unsafe(`DROP TRIGGER "${h.name}" ON ${rel}`);
  }
  for (const w of wanted.values()) {
    if (off === null) {
      const [m] = await tx<{ m: string }[]>`select mantle_check_box_mode('edit_check') as m`;
      off = m?.m === 'off';
    }
    await tx.unsafe(w.ddl);
    await tx.unsafe(`COMMENT ON TRIGGER "${w.name}" ON ${rel} IS '${editCheckNote(w.ddl)}'`);
    if (off) await tx.unsafe(`ALTER TABLE ${rel} DISABLE TRIGGER "${w.name}"`);
  }
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
      // The columns that exist now: a database migrated up to an older
      // migration (a test's) lacks a newer column the matrix names.
      const cols = (await tx.unsafe(
        `select table_schema || '.' || table_name as t, column_name as c
           from information_schema.columns where table_schema in ('public', 'auth')`,
      )) as unknown as { t: string; c: string }[];
      const has = grantColumnFilter(new Set(cols.map((r) => `${r.t}.${r.c}`)));
      for (const stmt of userGrantStatements(undefined, has)) await tx.unsafe(stmt);
      for (const stmt of writeGrantStatements(undefined, has)) await tx.unsafe(stmt);
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
  await syncGapWriterRights(sql);
}

/** The statement that brings GAP_WRITER_ROLE to its wanted state, every
 *  pass (fix round 3, D): made when missing, its attributes set again
 *  when it exists, as viewerRoleStatements does the viewer roles'. Pure. */
export function gapWriterRoleStatement(exists: boolean): string {
  return `${exists ? 'ALTER' : 'CREATE'} ROLE "${GAP_WRITER_ROLE}" WITH NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`;
}

/** The error a gap writer row rule change gives after its last try (fix
 *  round 3, F): what happened and what to do. */
export function gapWriterRuleLockError(table: string, cause: unknown): Error {
  return new Error(
    `migrate: could not take the lock to change the mantle_gap_writer row rule on ${table} ` +
      '(8 tries of 3 s each: the table was busy). The migrations are committed (0279 too); ' +
      'run migrate again: it is idempotent and picks up here.',
    { cause },
  );
}

/**
 * GAP_WRITER_ROLE, holding nothing (plan v3 S3): made when missing and its
 * lock attributes set again on every pass (gapWriterRoleStatement; a
 * cluster object, like the viewer roles), every table and sequence right
 * revoked, and every row rule that names it dropped, each in its own short
 * transaction (lock_timeout 3 s, with retries), as syncWriteRoleRules. Kept
 * one release so a rollback to the image before S3 finds it (rule 2).
 */
export async function syncGapWriterRights(sql: ReturnType<typeof postgres>): Promise<void> {
  const role = `"${GAP_WRITER_ROLE}"`;
  await withRoleRetry(() =>
    sql.begin(async (tx) => {
      const [has] = await tx<{ ok: boolean }[]>`
        select exists (select 1 from pg_roles where rolname = ${GAP_WRITER_ROLE}) as ok`;
      // Every pass: a role someone changed by hand gets its lock back.
      await tx.unsafe(gapWriterRoleStatement(!!has?.ok));
      await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public, auth FROM ${role}`);
      await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, auth FROM ${role}`);
    }),
  );
  const rules = await sql<{ t: string; name: string }[]>`
    select quote_ident(p.schemaname) || '.' || quote_ident(p.tablename) as t,
           p.policyname as name
      from pg_policies p
     where p.schemaname in ('public', 'auth') and ${GAP_WRITER_ROLE}::name = any(p.roles)`;
  for (const r of rules) {
    const stmt = `DROP POLICY "${r.name.replace(/"/g, '""')}" ON ${r.t}`;
    for (let attempt = 1; ; attempt++) {
      try {
        await withRoleRetry(() =>
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout = '3s'`);
            await tx.unsafe(stmt);
          }),
        );
        break;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (!RETRY_CODES.has(code)) throw err;
        if (attempt >= 8) throw gapWriterRuleLockError(r.t, err);
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  }
}

/** Errors a short policy change may meet on a busy box: a lock it waited
 *  for too long (lock_timeout) or a deadlock with live traffic. */
const RETRY_CODES = new Set(['55P03', '40P01']);

/**
 * The write role's row rules and write checks (mantle_write_role_sync_table,
 * 0278) and its A3a checks (syncEditChecks), one table per transaction:
 * every write table, every table with a read rule of the workspace role,
 * and every table that still carries a rule or check of the write role (the
 * matrix's schemas, public and auth). Each waits at most 3 s for its lock and
 * is tried again (8 times, 1 s apart): a policy change takes its table's
 * ACCESS EXCLUSIVE lock, so it must be short. A table whose rules match
 * takes no lock. A database migrated part way (no sync function yet) is
 * left as it is.
 */
export async function syncWriteRoleRules(sql: ReturnType<typeof postgres>): Promise<void> {
  const [ready] = await sql<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_write_role_sync_table(text,boolean,text[],text)') is not null as ok`;
  if (!ready?.ok) return;
  const byTable = new Map(ACCESS_MATRIX.map((t) => [t.table, t]));
  const others = await sql<{ t: string }[]>`
    select distinct schemaname || '.' || tablename as t from pg_policies
     where roles && array['mantle_view_user', 'mantle_write_user']::name[]
       and schemaname in ('public', 'auth')
    union
    select distinct n.nspname || '.' || c.relname from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where (tg.tgname = 'mantle_write_check' or tg.tgname = 'mantle_edit_check'
            or tg.tgname like 'mantle\\_edit\\_check\\_%')
       and tg.tgname::text <> all(${[...EDIT_CHECK_MIGRATION_TRIGGERS]}::text[])
       and n.nspname in ('public', 'auth')`;
  const tables = [...new Set([...WRITE_ROLE_TABLES, ...others.map((r) => r.t)])].sort();
  for (const table of tables) {
    const t = byTable.get(table);
    const write = t ? writeRoleWrites(t) : false;
    const args = t ? writeCheckArgs(t) : null;
    const rule = t ? writeRuleArg(t) : null;
    for (let attempt = 1; ; attempt++) {
      try {
        await withRoleRetry(() =>
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout = '3s'`);
            await tx`select mantle_write_role_sync_table(${table}, ${write}, ${args}::text[], ${rule}::text)`;
            await syncEditChecks(tx, table, t, write);
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
