/**
 * A5 step 6d (gateway survey finding 14): the client-sourced guard's answer
 * for every builtin and input shape equals main's. The oracle is main's
 * WRITE_RULES (v0.300.42, copied below as it was, with the dispatch main's
 * decide ran on it); the rules now live on each tool's policy
 * (`clientSourced`, the lowering and `createsIn` derived). A write rule is
 * judged by the same evaluator (writeVerdict, unchanged), against a stub
 * database in each of its answers (nothing exposed, an item exposed, an id
 * of no item, a folder shared with clients, an agent or a tool group
 * clients talk to, an app that exports a table).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Scenario = 'clean' | 'exposed' | 'missing' | 'shared' | 'agent' | 'group' | 'exports';
const state: { scenario: Scenario } = { scenario: 'clean' };

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const answer = (fields: Record<string, unknown>, table: unknown): unknown[] => {
    const s = state.scenario;
    if ('exposed' in fields) {
      return s === 'missing'
        ? []
        : Array.from({ length: 50 }, () => ({ id: 'x', exposed: s === 'exposed' }));
    }
    if (table === real.appTableExports) {
      return s === 'exports' ? [{ id: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e' }] : [];
    }
    if (table === real.nodes) return s === 'shared' ? [{ id: 'x' }] : [];
    if (table === real.agents) return s === 'agent' ? [{ id: 'x' }] : [];
    if (table === real.toolGroups) return s === 'group' ? [{ slug: 'x' }] : [];
    throw new Error('unexpected query');
  };
  const select = (fields: Record<string, unknown>) => {
    let table: unknown;
    const q = {
      from(t: unknown) {
        table = t;
        return q;
      },
      innerJoin: () => q,
      where: () => q,
      limit: () => q,
      then(res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) {
        return Promise.resolve()
          .then(() => answer(fields, table))
          .then(res, rej);
      },
    };
    return q;
  };
  return { ...real, db: { select } };
});
vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  asSystem: (fn: () => unknown) => fn(),
}));

import { listBuiltins } from './registry';
import { builtinPolicy, policyLowers } from './tool-policy';
import {
  clientSourcedGate,
  toolCreatesNodes,
  writeVerdict,
  type GateTool,
  type GateVerdict,
} from './client-sourced-rules';

type Input = Record<string, unknown>;

// ── main's WRITE_RULES, as it was ──────────────────────────────────────────

type MainRule =
  | { kind: 'free'; why: string }
  | { kind: 'lowering' }
  | { kind: 'always'; why: string; when?: (input: Input) => boolean }
  | {
      kind: 'write';
      nodes?: readonly string[];
      paths?: readonly string[];
      agents?: readonly string[];
      groups?: readonly string[];
      tools?: readonly string[];
      apps?: readonly string[];
      extraNodes?: (input: Input) => unknown[];
      creates?: true;
      alwaysWhen?: (input: Input) => boolean;
    };

const free = (why: string): MainRule => ({ kind: 'free', why });
const always = (why: string): MainRule => ({ kind: 'always', why });
const lowering: MainRule = { kind: 'lowering' };
const onNodes = (...fields: string[]): Extract<MainRule, { kind: 'write' }> => ({
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
const MAIN_WRITE_RULES: Readonly<Record<string, MainRule>> = {
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
  // Present's tools: new since main's table, written as main's rules would have
  // them (a create; a write into the canvas; the export is a file create,
  // as file_create, that waits when it overwrites).
  present_create: creates(),
  present_update: onNodes('id'),
  present_restore: onNodes('id'),
  present_delete: onNodes('id'),
  present_export: { ...creates(), alwaysWhen: overwrites, paths: ['parent_path'] },
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

const RUN: GateVerdict = { gate: false };
const wait = (why: string): GateVerdict => ({ gate: true, why });
const OWNER = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

/** main's decide for a builtin, on main's table. */
async function mainVerdict(ref: string, input: Input): Promise<GateVerdict> {
  try {
    const rule = Object.prototype.hasOwnProperty.call(MAIN_WRITE_RULES, ref)
      ? MAIN_WRITE_RULES[ref]
      : undefined;
    if (!rule) {
      return builtinPolicy(ref)?.effect === 'read'
        ? RUN
        : wait('a write tool the guard does not know');
    }
    switch (rule.kind) {
      case 'free':
        return RUN;
      case 'lowering': {
        const policy = builtinPolicy(ref);
        return policy && policyLowers(policy, input)
          ? wait('it would make brain content visible to clients or the public')
          : RUN;
      }
      case 'always':
        return !rule.when || rule.when(input) ? wait(rule.why) : RUN;
      case 'write':
        return await writeVerdict(OWNER, rule, input);
    }
  } catch {
    return wait('the target check failed');
  }
}

const ID = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
const ID2 = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';

/** The input shapes for a tool: every argument its schema names (and the
 *  overwrite and supersede switches) set to each kind of value. */
function shapes(props: string[]): Input[] {
  const all = (v: unknown, extra: Input = {}): Input => ({
    ...Object.fromEntries(props.map((p) => [p, v])),
    ...extra,
  });
  const out: Input[] = [{}];
  for (const v of [
    ID,
    'not-an-id',
    [ID, ID2],
    [ID, 7],
    'a.b',
    42,
    true,
    'public',
    'client',
    'team',
    '',
  ]) {
    out.push(all(v));
    out.push(all(v, { overwrite: true, supersede_source: true }));
  }
  // One argument at a time as an id, the rest absent.
  for (const p of props) out.push({ [p]: ID });
  return out;
}

const SCENARIOS: Scenario[] = [
  'clean',
  'exposed',
  'missing',
  'shared',
  'agent',
  'group',
  'exports',
];
const builtin = (slug: string): GateTool => ({ slug, handler: { kind: 'builtin', ref: slug } });

describe("the client-sourced guard answers as main's WRITE_RULES did (A5 step 6d)", () => {
  const tools = listBuiltins();
  beforeAll(() => {
    expect(tools.length).toBeGreaterThan(250);
  });

  it('main named only builtins that exist, and every builtin write', () => {
    const known = new Set(tools.map((t) => t.slug));
    expect(Object.keys(MAIN_WRITE_RULES).filter((s) => !known.has(s))).toEqual([]);
  });

  it('every builtin and input shape, in every database answer', async () => {
    const differ: string[] = [];
    let compared = 0;
    for (const t of tools) {
      const props = Object.keys(
        ((t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}) as object,
      );
      for (const input of shapes(props)) {
        for (const scenario of SCENARIOS) {
          state.scenario = scenario;
          const want = await mainVerdict(t.slug, input);
          const got = await clientSourcedGate({
            ownerId: OWNER,
            tool: builtin(t.slug),
            input,
            policyOf: builtinPolicy,
          });
          compared += 1;
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            differ.push(
              `${t.slug} ${scenario} ${JSON.stringify(input)}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
            );
          }
        }
      }
    }
    expect(differ.slice(0, 20)).toEqual([]);
    expect(compared).toBeGreaterThan(50_000);
  });

  it('every builtin makes new nodes exactly when main said so', () => {
    const differ = tools
      .filter((t) => {
        const r = MAIN_WRITE_RULES[t.slug];
        return toolCreatesNodes(builtin(t.slug)) !== (r?.kind === 'write' && r.creates === true);
      })
      .map((t) => t.slug);
    expect(differ).toEqual([]);
  });
});
