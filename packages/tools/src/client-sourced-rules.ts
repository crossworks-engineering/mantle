/**
 * The lowering guard, by TARGET (client logins C5 audit fixes, L2 and I1;
 * docs/client-logins.md section 8).
 *
 * A turn marked client-sourced (client-sourced.ts) may read freely. What
 * waits at /pending is any call that would put brain content in front of a
 * client or the public:
 *  - a lowering to client or public (`access_set`, a share link,
 *    `email_page` with a link);
 *  - a write INTO an item a client or the public already reads: a page,
 *    note, table, drawing, file, folder, formula or app, its blocks, rows,
 *    draft, commit, title or place. Since workspaces W5b2 that is its
 *    grants: a workspace with a client user holds it (its own grant or its
 *    folder's), or a live open link shows it (its item or its served list).
 *    An embed changes no one's access any more, so the target alone decides;
 *  - a destination folder a client workspace reads (what lands there takes
 *    its rows);
 *  - a write into an agent or tool group at client or public level (a new
 *    tool in the client agent's group, say);
 *  - anything whose target cannot be read from its input (a command, a run,
 *    a recipe with a write step, a connector's tool).
 *
 * Every built-in tool that is not marked `readOnly` is classified below. The
 * sweep (client-sourced-rules.test.ts) fails when one is missing, so a new
 * write tool cannot slip past silently; at run time an unclassified write
 * (a builtin registered elsewhere) waits too. The owner approving the
 * pending entry runs the original call.
 */
import { and, arrayOverlaps, eq, inArray, or, sql } from 'drizzle-orm';
import { agents, appTableExports, db, nodes, toolGroups } from '@mantle/db';
import { asSystem } from '@mantle/db/viewer';
import { clientWsSql } from './client-sourced';
import { policyLowers, type ToolPolicy } from './tool-policy';

type Input = Record<string, unknown>;

export type WriteRule =
  /** Writes nothing a client or the public reads. */
  | { kind: 'free'; why: string }
  /** access_set, the share tools, email_page: the tool's policy decides
   *  (`lowering`, policyLowers; A5 step 6a deleted isLoweringCall). */
  | { kind: 'lowering' }
  /** The target cannot be read from the input: every call waits (or only
   *  those `when` picks). */
  | { kind: 'always'; why: string; when?: (input: Input) => boolean }
  | {
      kind: 'write';
      /** Input fields naming the existing nodes it writes into (an id or a
       *  list of ids), destination folders included. A value that is not an
       *  id, or an id of no node of this brain, waits (the check fails
       *  closed). */
      nodes?: readonly string[];
      /** Input fields naming a destination folder by its ltree path: what
       *  lands there takes the share of a folder at or above it (folder
       *  sharing), so a client-shared one waits. A path that does not parse
       *  waits too. */
      paths?: readonly string[];
      /** Input fields naming agents / tool groups by slug. */
      agents?: readonly string[];
      groups?: readonly string[];
      /** Input fields naming tools by slug: the groups that hold the tool. */
      tools?: readonly string[];
      /** Input fields naming apps by id: the app and the brain tables it
       *  exports (app-table-exports.ts). */
      apps?: readonly string[];
      /** Node ids it writes that depend on another field (a source it
       *  supersedes). */
      extraNodes?: (input: Input) => unknown[];
      /** It makes new nodes: in a marked turn they carry the mark. */
      creates?: true;
      /** When this holds, the target cannot be read from the input and the
       *  call waits (a file overwrite named by path). */
      alwaysWhen?: (input: Input) => boolean;
    };

const free = (why: string): WriteRule => ({ kind: 'free', why });
const always = (why: string): WriteRule => ({ kind: 'always', why });
const lowering: WriteRule = { kind: 'lowering' };
const onNodes = (...fields: string[]): Extract<WriteRule, { kind: 'write' }> => ({
  kind: 'write',
  nodes: fields,
});
const creates = (...parentFields: string[]) =>
  ({ kind: 'write', nodes: parentFields, creates: true }) as const;
const onApp = { kind: 'write', apps: ['id'] } as const;
const isTrue = (v: unknown) => v === true || v === 'true';
const overwrites = (input: Input) => isTrue(input.overwrite);
const supersedes = (field: string) => (input: Input) =>
  isTrue(input.supersede_source) ? [input[field]].flat() : [];

const READS = 'reads only';
const OUTWARD = 'sends outside the brain (confirm-gated as well)';
const WEB = 'reads the web';
const UNSEEN = 'it runs code or actions whose target its input does not name';
const LATER = "a run's workers act later, outside this turn";
const RECALL_GUIDANCE =
  "Recall is the owner's guidance to every agent; a card keeps no client mark";

/**
 * Every built-in write tool (every builtin not marked `readOnly`), by slug.
 * Grow it with each new tool; the sweep test names the missing ones.
 */
export const WRITE_RULES: Readonly<Record<string, WriteRule>> = {
  // ── Levels and links ──────────────────────────────────────────────────────
  access_set: lowering,
  node_share: lowering,
  page_share: lowering,
  email_page: lowering,
  node_unshare: free('takes a link away'),
  page_unshare: free('takes a link away'),

  // ── Agents, tool groups, tools, persona ──────────────────────────────────
  agent_grant_tool_group: { kind: 'write', agents: ['agent_slug'], groups: ['group_slug'] },
  agent_set_thinking_effort: { kind: 'write', agents: ['agent_slug'] },
  tool_group_ensure: { kind: 'write', groups: ['slug'] },
  api_docs_set: { kind: 'write', groups: ['group_slug'] },
  api_skill_set: { kind: 'write', groups: ['group_slug'] },
  api_tool_create: { kind: 'write', groups: ['group_slug'] },
  api_tool_update: { kind: 'write', groups: ['group_slug'], tools: ['slug'] },
  api_tool_delete: free('removes a tool; hands nothing out'),
  api_tool_test: always(UNSEEN),
  recipe_tool_create: free('a new tool in no group; adding it to a group is checked there'),
  recipe_tool_test: always(UNSEEN),
  sandbox_publish: { kind: 'write', groups: ['group_slug'] },
  update_persona: free("the owner's persona notes; team and client turns load none"),
  worker_group_ensure: free('worker routing (MCP only)'),
  model_pool_set: free('model routing'),
  model_pool_remove: free('model routing'),
  set_timezone: free("the owner's time zone"),

  // ── Pages ────────────────────────────────────────────────────────────────
  page_create: creates('folder_id', 'parent_id'),
  page_update: onNodes('id'),
  page_update_draft: onNodes('id'),
  page_commit: onNodes('id'),
  page_discard_draft: onNodes('id'),
  page_delete: onNodes('id'),
  page_move: onNodes('id', 'folder_id', 'parent_id'),
  page_mention: onNodes('page_id'),
  page_block_append: onNodes('page_id'),
  page_block_insert_after: onNodes('page_id'),
  page_block_insert_before: onNodes('page_id'),
  page_block_update: onNodes('page_id'),
  page_block_delete: onNodes('page_id'),
  page_blocks_apply: onNodes('page_id'),
  page_replace_from_file: onNodes('page_id'),
  page_extract_section: creates('page_id'),
  page_split: creates('page_id'),
  page_from_file: { ...creates(), extraNodes: supersedes('file_id') },
  page_from_journal: creates('folder_id', 'parent_id'),
  page_from_note: { ...creates('folder_id', 'parent_id'), extraNodes: supersedes('note_id') },
  page_from_notes: { ...creates('folder_id', 'parent_id'), extraNodes: supersedes('note_ids') },

  // ── Notes ────────────────────────────────────────────────────────────────
  note_create: creates(),
  note_update: onNodes('id'),
  note_delete: onNodes('id'),
  note_from_file: creates(),
  note_from_page: creates(),

  // ── Tables ───────────────────────────────────────────────────────────────
  table_create: creates(),
  table_from_file: creates(),
  table_from_text: creates(),
  table_update: onNodes('id'),
  table_commit: onNodes('id'),
  table_delete: onNodes('id'),
  table_snapshot_create: onNodes('id'),
  table_snapshot_restore: onNodes('id'),
  table_snapshot_delete: onNodes('id'),
  table_cell_set: onNodes('table_id'),
  table_column_add: onNodes('table_id'),
  table_column_update: onNodes('table_id'),
  table_column_delete: onNodes('table_id'),
  table_row_add: onNodes('table_id'),
  table_row_update: onNodes('table_id'),
  table_row_delete: onNodes('table_id'),
  table_rows_add: onNodes('table_id'),
  table_rows_upsert: onNodes('table_id'),
  table_set_aggregate: onNodes('table_id'),
  table_set_view: onNodes('table_id'),
  table_tab_add: onNodes('table_id'),
  table_tab_rename: onNodes('table_id'),
  table_tab_delete: onNodes('table_id'),
  table_row_get: free(READS),

  // ── Files and folders ────────────────────────────────────────────────────
  file_create: { ...creates(), alwaysWhen: overwrites, paths: ['parent_path'] },
  file_upload: { ...creates(), alwaysWhen: overwrites, paths: ['parent_path'] },
  file_copy: { ...creates(), paths: ['dest_path'] },
  file_move: { ...onNodes('file_id'), paths: ['dest_path'] },
  file_rename: onNodes('file_id'),
  file_set_indexing: onNodes('file_id'),
  file_delete: onNodes('file_id'),
  folder_create: { ...creates(), paths: ['parent_path'] },
  folder_copy: { ...creates(), paths: ['dest_parent_path'] },
  folder_move: { ...onNodes('folder_id'), paths: ['dest_parent_path'] },
  folder_rename: onNodes('folder_id'),
  folder_describe: onNodes('folder_id'),
  folder_set_indexing: onNodes('folder_id'),
  folder_delete: onNodes('folder_id'),
  // The item tree's folders for the row-only kinds (builtins-tree.ts). A
  // folder at the top level names no parent, so that create waits.
  tree_folder_create: creates('parent_id'),
  // A move names its destination folder: what lands in a shared folder takes
  // its share (null, the top level, is never shared).
  tree_folder_update: onNodes('folder_id', 'parent_id'),
  tree_item_move: onNodes('item_ids', 'folder_id'),
  tree_folder_delete: onNodes('folder_id'),
  export_node: creates(),
  sheet_build: creates(),
  generate_image: creates(),
  route_map: creates(),
  video_ingest: creates(),
  show_image: free('shows a file in this chat'),
  synthesize_speech: free('speaks in this chat'),

  // ── Apps ─────────────────────────────────────────────────────────────────
  app_create: creates(),
  app_update: onApp,
  app_build: onApp,
  app_db_schema_set: onApp,
  app_db_seed: onApp,
  app_delete: onApp,
  app_file_write: onApp,
  app_file_delete: onApp,
  app_publish: onApp,
  app_source_set: onApp,
  app_tools_set: onApp,
  app_table_export_set: { ...onApp, creates: true },
  app_table_export_remove: onApp,
  app_snapshot_create: onApp,
  app_snapshot_restore: onApp,
  app_snapshot_delete: onApp,
  app_undelete: creates(),
  app_duplicate: onApp,
  app_export: onApp,
  // A package from anywhere: its code is built and can be published. It is
  // granted no tools (app-package-import.ts), but what the code does is
  // still not in the input, so a client-sourced import always waits.
  app_import: always(UNSEEN),

  // ── Records (tasks, events, contacts, journal, formulas, secrets) ────────
  task_create: creates(),
  task_update: onNodes('id'),
  task_delete: onNodes('id'),
  event_create: creates(),
  event_update: onNodes('id'),
  event_delete: onNodes('id'),
  contact_create: creates(),
  contact_update: onNodes('id'),
  contact_delete: onNodes('id'),
  journal_create: creates(),
  journal_update: onNodes('id'),
  journal_resolve_gap: onNodes('id'),
  journal_delete: onNodes('id'),
  formula_create: creates(),
  formula_update: onNodes('id'),
  formula_delete: onNodes('id'),
  secret_create: creates(),
  location_save: creates(),
  content_supersede: onNodes('node_id', 'superseded_by'),
  process_extraction: onNodes('node_id'),

  // ── Runs, sandboxes, the terminal: targets the input does not name ────────
  run_plan: always(LATER),
  run_append: always(LATER),
  run_audit: always(LATER),
  run_cancel: free('stops work'),
  run_terminal: always(UNSEEN),
  sandbox_exec: always(UNSEEN),
  sandbox_mcp_call: always(UNSEEN),
  sandbox_autostart: always(UNSEEN),
  sandbox_create: free('an empty container'),
  sandbox_import: free('copies a brain file into a sandbox'),
  sandbox_export: creates(),
  sandbox_stop: free('stops a container'),
  sandbox_rm: free('removes a container (confirm-gated)'),
  pending_approve: always('it runs a queued call (MCP only)'),
  pending_reject: free('drops a queued call'),
  invoke_agent: free("the child shares this turn's mark, so its own calls are checked"),

  // ── Outward and chat ─────────────────────────────────────────────────────
  email_send: always(OUTWARD),
  telegram_send: always(OUTWARD),
  telegram_edit: always(OUTWARD),
  telegram_pair: always('it gives a chat access to an agent (MCP only)'),
  telegram_react: free('a reaction on a message (MCP only)'),
  telegram_mark_processed: free('marks an inbound message done (MCP only)'),

  // ── Reads not marked readOnly (they spend, or reach outside) ──────────────
  web_fetch: free(WEB),
  web_crawl: free(WEB),
  web_map: free(WEB),
  web_search: free(WEB),
  web_search_pro: free(WEB),
  model_catalog: free(READS),
  model_pool_list: free(READS),
  openrouter_benchmarks: free(READS),
  openrouter_rankings: free(READS),
  openrouter_task_classes: free(READS),
  recall_eval: free('scores retrieval; writes nothing a client reads'),
  // Recall v2 authoring. No client reads a map (admin-only, not shareable
  // below team), but that is not the risk here: Recall is where agents are
  // TOLD what to do. Cards are rows, not nodes, so text a client-marked turn
  // wrote into one would never be seen as client-sourced again, and every
  // later agent would read it as the owner's guidance. So in a marked turn
  // every Recall write waits for the owner (Recall audit N7, 2026-09-30).
  recall_map_create: always(RECALL_GUIDANCE),
  recall_card_put: always(RECALL_GUIDANCE),
  recall_card_delete: always(RECALL_GUIDANCE),
  recall_map_update: always(RECALL_GUIDANCE),
  // The owner's own Recall acts, MCP only (builtins-recall-owner.ts). Never
  // granted in the app; classified all the same, for the same reason.
  recall_prompt_confirm: always(RECALL_GUIDANCE),
  recall_map_publish: always(RECALL_GUIDANCE),
  recall_map_delete: always(RECALL_GUIDANCE),
  recall_cards_reorder: always(RECALL_GUIDANCE),
  recall_revision_restore: always(RECALL_GUIDANCE),
  recall_map_set_slug: always(RECALL_GUIDANCE),
  recall_card_set_slug: always(RECALL_GUIDANCE),
  // App rows on a login's own MCP (team apps Phase 1): no agent turn holds
  // it, but if one ever did, it writes the app's data and the brain tables
  // the app exports.
  app_data_write: { kind: 'write', apps: ['app_id'] },
  // A member's own mini apps (team apps Phase 3): the caller's own app in
  // their own space, private until they share it; no agent turn
  // holds them (the login MCP surface adds them for a member).
  // To the member's own trash and back (access matrix N6): nothing removed.
  // Calls on a federated peer as the login it binds us to.
  peer_call: always(OUTWARD),
  peer_file_copy: always(OUTWARD),
};

/** A tool as the gate sees it: its slug and its handler descriptor. */
export type GateTool = { slug: string; handler: unknown };

export type GateVerdict = { gate: false } | { gate: true; why: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a client or the public reads the row's item: a client workspace
 *  holds it (its own grant or its folder's), or a live open link shows it
 *  (the link's own item, or on its served list). */
function exposedSql(ownerId: string) {
  // Written out in full: inside the subquery an unqualified id would name
  // the share's own id.
  return sql<boolean>`(
    "nodes"."read_ws" && ${clientWsSql(ownerId)}
    or exists (
      select 1 from shares s
       where s.owner_id = ${ownerId} and s.revoked_at is null and s.contact_id is null
         and (s.expires_at is null or s.expires_at > now())
         and coalesce(s.settings->>'mode', 'public') <> 'team'
         and (s.node_id = "nodes"."id"
              or coalesce(s.settings->'served', '[]'::jsonb) ? lower("nodes"."id"::text))))`;
}
const RUN: GateVerdict = { gate: false };
const wait = (why: string): GateVerdict => ({ gate: true, why });

/** The builtin a tool row runs (its handler ref), or null for another kind. */
function builtinRef(tool: GateTool): string | null {
  const h = tool.handler as { kind?: string; ref?: string } | null;
  if (h?.kind !== 'builtin') return null;
  return h.ref ?? tool.slug;
}

/** The rule for a builtin, or undefined when it is not classified. */
export function writeRuleFor(ref: string): WriteRule | undefined {
  return Object.prototype.hasOwnProperty.call(WRITE_RULES, ref) ? WRITE_RULES[ref] : undefined;
}

/** Whether this tool makes new nodes (so a marked turn marks them). */
export function toolCreatesNodes(tool: GateTool): boolean {
  const ref = builtinRef(tool);
  const rule = ref ? writeRuleFor(ref) : undefined;
  return rule?.kind === 'write' && rule.creates === true;
}

/** The values of `fields` in `input`, flattened (absent or empty skipped). */
function valuesOf(input: Input, fields: readonly string[] | undefined): unknown[] {
  const out: unknown[] = [];
  for (const f of fields ?? []) {
    const v = input[f];
    if (v === undefined || v === null || v === '') continue;
    out.push(...(Array.isArray(v) ? (v as unknown[]) : [v]));
  }
  return out;
}

/** The trimmed strings among `vals`; null when any value is not a string. */
function stringsOf(vals: unknown[]): string[] | null {
  const out: string[] = [];
  for (const v of vals) {
    if (typeof v !== 'string') return null;
    out.push(v.trim());
  }
  return out;
}

/**
 * What a MARKED turn may do with this call: run it, or send it to pending
 * with the reason. Called only once the turn is marked. `policyOf` is the
 * registry's own policy lookup (builtinPolicy), passed in so this module
 * stays free of the registry: a builtin's effect and its `lowering` are read
 * from it. A failed check sends the call to pending.
 */
export async function clientSourcedGate(p: {
  ownerId: string;
  tool: GateTool;
  input: Input;
  policyOf: (slug: string) => ToolPolicy | null;
}): Promise<GateVerdict> {
  try {
    return await decide(p);
  } catch {
    return wait('the target check failed');
  }
}

async function decide(p: {
  ownerId: string;
  tool: GateTool;
  input: Input;
  policyOf: (slug: string) => ToolPolicy | null;
}): Promise<GateVerdict> {
  const readOnly = (slug: string) => p.policyOf(slug)?.effect === 'read';
  const ref = builtinRef(p.tool);
  if (ref === null) {
    // A recipe of reads only reads; an HTTP GET reads. Anything else a user
    // or a connector defined may write where its input does not say.
    const h = p.tool.handler as {
      kind?: string;
      method?: string;
      steps?: { tool?: unknown }[];
    } | null;
    if (h?.kind === 'recipe') {
      const reads = (h.steps ?? []).every((s) => typeof s.tool === 'string' && readOnly(s.tool));
      return reads ? RUN : wait('a recipe with a step that writes');
    }
    if (h?.kind === 'http' && (h.method ?? 'GET').toUpperCase() === 'GET') return RUN;
    return wait('a tool that can write where its input does not say');
  }
  const rule = writeRuleFor(ref);
  if (!rule) return readOnly(ref) ? RUN : wait('a write tool the guard does not know');
  switch (rule.kind) {
    case 'free':
      return RUN;
    case 'lowering': {
      const policy = p.policyOf(ref);
      return policy && policyLowers(policy, p.input)
        ? wait('it would make brain content visible to clients or the public')
        : RUN;
    }
    case 'always':
      return !rule.when || rule.when(p.input) ? wait(rule.why) : RUN;
    case 'write':
      return writeVerdict(p.ownerId, rule, p.input);
  }
}

async function writeVerdict(
  ownerId: string,
  rule: Extract<WriteRule, { kind: 'write' }>,
  input: Input,
): Promise<GateVerdict> {
  if (rule.alwaysWhen?.(input)) return wait('its target is named by path, not by id');
  const nodeIds = stringsOf([...valuesOf(input, rule.nodes), ...(rule.extraNodes?.(input) ?? [])]);
  const appIds = stringsOf(valuesOf(input, rule.apps));
  // An item named by anything but an id cannot be checked: it waits.
  if (!nodeIds || !appIds || [...nodeIds, ...appIds].some((id) => !UUID_RE.test(id))) {
    return wait('its target is not named by id');
  }
  const paths = stringsOf(valuesOf(input, rule.paths));
  if (!paths) return wait('its destination is not named by path');
  const agentSlugs = stringsOf(valuesOf(input, rule.agents)) ?? [];
  const groupSlugs = stringsOf(valuesOf(input, rule.groups)) ?? [];
  const toolSlugs = stringsOf(valuesOf(input, rule.tools)) ?? [];
  const named =
    nodeIds.length +
    appIds.length +
    paths.length +
    agentSlugs.length +
    groupSlugs.length +
    toolSlugs.length;
  if (named === 0) return RUN;
  return asSystem(async (): Promise<GateVerdict> => {
    // An app: the app itself and every brain table it exports.
    const exported =
      appIds.length > 0
        ? await db
            .select({ id: appTableExports.tableNodeId })
            .from(appTableExports)
            .where(
              and(eq(appTableExports.ownerId, ownerId), inArray(appTableExports.appNodeId, appIds)),
            )
        : [];
    const wanted = [
      ...new Set([...nodeIds, ...appIds, ...exported.map((e) => e.id)].map((i) => i.toLowerCase())),
    ];
    if (wanted.length > 0) {
      const rows = await db
        .select({ id: nodes.id, exposed: exposedSql(ownerId) })
        .from(nodes)
        .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, wanted)));
      if (rows.length < wanted.length) return wait('its target is not an item of this brain');
      // Read by a client (a workspace with a client user holds it, by its
      // own grant or its folder's) or by the public (an open link shows it).
      if (rows.some((r) => r.exposed === true)) {
        return wait('it writes into an item clients or the public read');
      }
    }
    for (const path of paths) {
      // A folder at or above the destination that a client workspace reads:
      // what lands there takes the folder's rows (S6).
      const [shared] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            eq(nodes.type, 'branch'),
            sql`${nodes.path} @> ${path}::ltree`,
            sql`${nodes.readWs} && ${clientWsSql(ownerId)}`,
          ),
        )
        .limit(1);
      if (shared) return wait('it puts something in a folder shared with clients');
    }
    // An agent a client talks to: the assistant of a workspace with a
    // client user (agent and tool-group levels are gone, workspaces W7b).
    if (agentSlugs.length > 0) {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.ownerId, ownerId),
            inArray(agents.slug, agentSlugs),
            sql`${agents.workspaceId} = any(${clientWsSql(ownerId)})`,
          ),
        )
        .limit(1);
      if (rows.length > 0) {
        return wait('it changes an agent clients talk to');
      }
    }
    // A tool group such an assistant holds.
    if (groupSlugs.length > 0 || toolSlugs.length > 0) {
      const byGroup = groupSlugs.length > 0 ? inArray(toolGroups.slug, groupSlugs) : undefined;
      const byTool =
        toolSlugs.length > 0 ? arrayOverlaps(toolGroups.toolSlugs, toolSlugs) : undefined;
      const rows = await db
        .select({ slug: toolGroups.slug })
        .from(toolGroups)
        .innerJoin(
          agents,
          and(
            eq(agents.ownerId, toolGroups.ownerId),
            sql`${toolGroups.slug} = any(${agents.toolGroupSlugs})`,
          ),
        )
        .where(
          and(
            eq(toolGroups.ownerId, ownerId),
            or(byGroup, byTool),
            sql`${agents.workspaceId} = any(${clientWsSql(ownerId)})`,
          ),
        )
        .limit(1);
      if (rows.length > 0) {
        return wait('it changes a tool group an agent clients talk to holds');
      }
    }
    return RUN;
  }, 'client-sourced-check');
}
