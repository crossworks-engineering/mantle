/**
 * The lowering guard, by TARGET (client logins C5 audit fixes, L2 and I1;
 * docs/client-logins.md section 8).
 *
 * A turn marked client-sourced (client-sourced.ts) may read freely. What
 * waits at /pending is any call that would put brain content in front of a
 * client or the public:
 *  - a lowering to client or public (`access_set`, a share link,
 *    `email_page` with a link);
 *  - a write INTO an item already at client or public level: a page, note,
 *    table, drawing, file, folder, formula or app, its blocks, rows, draft,
 *    commit, title or place. A commit takes the item's embeds down to the
 *    item's own level (embed-closure.ts), so a write into an item at team or
 *    admin level can never lower anything to client or public: checking the
 *    target's level checks the closure the write would lower too;
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
import { and, arrayOverlaps, eq, inArray, or } from 'drizzle-orm';
import { agents, appTableExports, db, nodes, toolGroups } from '@mantle/db';
import { asSystem } from '@mantle/db/viewer';
import { isLoweringCall } from './client-sourced';

type Input = Record<string, unknown>;

export type WriteRule =
  /** Writes nothing a client or the public reads. */
  | { kind: 'free'; why: string }
  /** access_set, the share tools, email_page: `isLoweringCall` decides. */
  | { kind: 'lowering' }
  /** The target cannot be read from the input: every call waits (or only
   *  those `when` picks). */
  | { kind: 'always'; why: string; when?: (input: Input) => boolean }
  | {
      kind: 'write';
      /** Input fields naming the existing nodes it writes into (an id or a
       *  list of ids). A value that is not an id, or an id of no node of
       *  this brain, waits (the check fails closed). */
      nodes?: readonly string[];
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
const onNodes = (...fields: string[]): WriteRule => ({ kind: 'write', nodes: fields });
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
const OWN_SPACE = "reads the caller's own space";
const UNSEEN = 'it runs code or actions whose target its input does not name';
const LATER = "a run's workers act later, outside this turn";

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
  page_create: creates('parent_id'),
  page_update: onNodes('id'),
  page_update_draft: onNodes('id'),
  page_commit: onNodes('id'),
  page_discard_draft: onNodes('id'),
  page_delete: onNodes('id'),
  page_move: onNodes('id', 'parent_id'),
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
  page_from_journal: creates('parent_id'),
  page_from_note: { ...creates('parent_id'), extraNodes: supersedes('note_id') },
  page_from_notes: { ...creates('parent_id'), extraNodes: supersedes('note_ids') },

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
  file_create: { ...creates(), alwaysWhen: overwrites },
  file_upload: { ...creates(), alwaysWhen: overwrites },
  file_copy: creates(),
  file_move: onNodes('file_id'),
  file_rename: onNodes('file_id'),
  file_set_indexing: onNodes('file_id'),
  file_delete: onNodes('file_id'),
  folder_create: creates(),
  folder_copy: creates(),
  folder_move: onNodes('folder_id'),
  folder_rename: onNodes('folder_id'),
  folder_describe: onNodes('folder_id'),
  folder_set_indexing: onNodes('folder_id'),
  folder_delete: onNodes('folder_id'),
  // The item tree's folders for the row-only kinds (builtins-tree.ts). A
  // folder at the top level names no parent, so that create waits.
  tree_folder_create: creates('parent_id'),
  tree_folder_update: onNodes('folder_id'),
  tree_item_move: onNodes('item_ids'),
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

  // ── Records (tasks, events, contacts, journal, formulas, secrets) ────────
  task_create: creates(),
  task_update: onNodes('id'),
  task_delete: onNodes('id'),
  task_comment_add: onNodes('id'),
  team_request_create: creates(),
  client_request_create: creates(),
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
  my_items_list: free(OWN_SPACE),
  my_item_open: free(OWN_SPACE),
};

/** A tool as the gate sees it: its slug and its handler descriptor. */
export type GateTool = { slug: string; handler: unknown };

export type GateVerdict = { gate: false } | { gate: true; why: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPOSED: ReadonlySet<string> = new Set(['client', 'public']);
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
 * with the reason. Called only once the turn is marked. `isReadOnlyBuiltin`
 * is the registry's own flag, passed in so this module stays free of the
 * registry. A failed check sends the call to pending.
 */
export async function clientSourcedGate(p: {
  ownerId: string;
  tool: GateTool;
  input: Input;
  isReadOnlyBuiltin: (slug: string) => boolean;
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
  isReadOnlyBuiltin: (slug: string) => boolean;
}): Promise<GateVerdict> {
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
      const reads = (h.steps ?? []).every(
        (s) => typeof s.tool === 'string' && p.isReadOnlyBuiltin(s.tool),
      );
      return reads ? RUN : wait('a recipe with a step that writes');
    }
    if (h?.kind === 'http' && (h.method ?? 'GET').toUpperCase() === 'GET') return RUN;
    return wait('a tool that can write where its input does not say');
  }
  const rule = writeRuleFor(ref);
  if (!rule) return p.isReadOnlyBuiltin(ref) ? RUN : wait('a write tool the guard does not know');
  switch (rule.kind) {
    case 'free':
      return RUN;
    case 'lowering':
      return isLoweringCall(ref, p.input)
        ? wait('it would make brain content visible to clients or the public')
        : RUN;
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
  const agentSlugs = stringsOf(valuesOf(input, rule.agents)) ?? [];
  const groupSlugs = stringsOf(valuesOf(input, rule.groups)) ?? [];
  const toolSlugs = stringsOf(valuesOf(input, rule.tools)) ?? [];
  const named =
    nodeIds.length + appIds.length + agentSlugs.length + groupSlugs.length + toolSlugs.length;
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
        .select({ id: nodes.id, audience: nodes.audience })
        .from(nodes)
        .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, wanted)));
      if (rows.length < wanted.length) return wait('its target is not an item of this brain');
      if (rows.some((r) => EXPOSED.has(r.audience))) {
        return wait('it writes into an item clients or the public read');
      }
    }
    if (agentSlugs.length > 0) {
      const rows = await db
        .select({ audience: agents.audience })
        .from(agents)
        .where(and(eq(agents.ownerId, ownerId), inArray(agents.slug, agentSlugs)));
      if (rows.some((r) => EXPOSED.has(r.audience))) {
        return wait('it changes an agent clients or the public talk to');
      }
    }
    if (groupSlugs.length > 0 || toolSlugs.length > 0) {
      const byGroup = groupSlugs.length > 0 ? inArray(toolGroups.slug, groupSlugs) : undefined;
      const byTool =
        toolSlugs.length > 0 ? arrayOverlaps(toolGroups.toolSlugs, toolSlugs) : undefined;
      const rows = await db
        .select({ audience: toolGroups.audience })
        .from(toolGroups)
        .where(and(eq(toolGroups.ownerId, ownerId), or(byGroup, byTool)));
      if (rows.some((r) => EXPOSED.has(r.audience))) {
        return wait('it changes a tool group a client or public agent can hold');
      }
    }
    return RUN;
  });
}
