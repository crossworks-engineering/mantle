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
import { viewerRoleName } from './viewer';

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
  | 'team-drafts';

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
  read: LimitedRead;
  rule: RowRule;
  writer: Writer;
  /** The personal-space role. Absent = none. */
  space?: SpaceAccess;
};

const none = (table: string, writer: Writer = 'admin'): TableAccess => ({
  table,
  read: 'none',
  rule: 'none',
  writer,
});

export const ACCESS_MATRIX: readonly TableAccess[] = [
  // ── Brain content: readable at the viewer's level ─────────────────────────
  { table: 'public.nodes', read: 'all', rule: 'brain-level', writer: 'content', space: 'write' },
  { table: 'public.content_chunks', read: 'all', rule: 'follows-node', writer: 'content' },
  { table: 'public.facts', read: 'all', rule: 'source-node', writer: 'content' },
  {
    table: 'public.pages',
    read: ['node_id', 'doc', 'doc_text', 'version', 'created_at', 'updated_at'],
    rule: 'follows-node',
    writer: 'content',
    space: 'write',
  },
  {
    table: 'public.draws',
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
    read: [
      'node_id',
      'source',
      'source_text',
      'manifest',
      'published_build',
      'version',
      'created_at',
      'updated_at',
    ],
    rule: 'follows-node',
    writer: 'content',
  },
  { table: 'public.app_databases', read: 'all', rule: 'follows-node', writer: 'content' },

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
  // Read only through mantle_is_brain_space() (security definer).
  none('public.spaces'),

  // ── Configuration the turn loop reads (no per-row secrecy) ────────────────
  { table: 'public.agents', read: 'all', rule: 'all-rows', writer: 'admin' },
  { table: 'public.tools', read: 'all', rule: 'all-rows', writer: 'admin' },
  { table: 'public.tool_groups', read: 'all', rule: 'all-rows', writer: 'admin' },
  { table: 'public.skills', read: 'all', rule: 'all-rows', writer: 'admin' },
  { table: 'public.embedding_config', read: 'all', rule: 'all-rows', writer: 'admin' },
  { table: 'public.ai_workers', read: 'all', rule: 'all-rows', writer: 'admin' },
  { table: 'public.profiles', read: 'all', rule: 'all-rows', writer: 'admin' },
  // mantle_brain_id() reads the anchor row; nothing else of a login.
  {
    table: 'auth.users',
    read: ['id', 'is_owner', 'created_at'],
    rule: 'all-rows',
    writer: 'admin',
  },

  // ── Infrastructure: written through systemDb, never read by a viewer ─────
  none('public.traces', 'system'),
  none('public.trace_steps', 'system'),
  none('public.tool_results', 'system'),
  none('public.tool_result_chunks', 'system'),
  none('public.pending_tool_calls', 'system'),
  none('public.turn_stream_buffer', 'system'),
  none('public.audit_log', 'system'),
  none('public.app_access_log', 'system'),
  none('public.team_access_log', 'system'),
  none('public.embedding_cache', 'system'),
  none('public.team_messages', 'system'),
  none('public.team_notifications', 'system'),
  none('public.team_read_cursors', 'system'),
  none('public.assistant_read_cursors', 'system'),
  none('public.forum_read_cursors', 'system'),
  none('public.sync_runs', 'system'),
  none('public.maintenance_runs', 'system'),
  none('public.heartbeat_fires', 'system'),
  none('public.runs', 'system'),
  none('public.run_items', 'system'),
  none('public.push_instance', 'system'),
  none('public.push_prefs', 'system'),
  none('public.push_subscriptions', 'system'),
  none('public.shares', 'system'),

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
  none('public.pairing_codes'),
  none('public.contact_team_tokens'),
  none('public.mantle_peers'),
  none('public.peer_shares'),
  none('public.peer_share_scopes'),
  none('public.assistant_messages'),
  none('public.entities', 'content'),
  none('public.entity_edges', 'content'),
  none('public.entity_merge_dismissals'),
  none('public.recall_maps'),
  none('public.recall_nodes'),
  // Comments on personal items (Phase 2): the space role reads and writes its
  // own login's comments on its own items; the team role reads the comments on
  // teammates' team-shared items (human flag on). Brain threads stay admin.
  {
    table: 'public.node_comments',
    read: 'all',
    rule: 'team-drafts',
    writer: 'content',
    space: 'write',
  },
  none('public.agent_groups'),
  none('public.channels'),
  none('public.curated_models'),
  none('public.prompt_versions'),
  none('public.doc_collections'),
  none('public.ingest_rules'),
  none('public.saved_filters'),
  none('public.heartbeats'),
  none('public.sandboxes'),
  none('public.app_table_exports'),
  none('public.forum_topics', 'content'),
  none('public.forum_posts', 'content'),
  none('public.forum_uploads', 'content'),
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
export function viewerGrantStatements(role: string): string[] {
  const out: string[] = [];
  for (const t of ACCESS_MATRIX) {
    if (t.read === 'none') continue;
    const cols = t.read === 'all' ? '' : ` (${t.read.map((c) => `"${c}"`).join(', ')})`;
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

/**
 * Make the live grants equal the matrix: revoke everything the limited roles
 * hold on every table in the matrix, then grant what it lists. One
 * transaction, idempotent; migrate runs it after the migrations.
 */
export async function applyViewerGrants(sql: ReturnType<typeof postgres>): Promise<void> {
  const levelRoles = LIMITED_LEVELS.map(viewerRoleName);
  const roleList = POOL_ROLES.map((r) => `"${viewerRoleName(r)}"`).join(', ');
  await sql.begin(async (tx) => {
    await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleList}`);
    await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM ${roleList}`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public, auth TO ${roleList}`);
    for (const role of levelRoles) {
      for (const stmt of viewerGrantStatements(role)) await tx.unsafe(stmt);
    }
    for (const stmt of spaceGrantStatements()) await tx.unsafe(stmt);
  });
}
