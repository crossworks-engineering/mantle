/**
 * Live "what is this specialist doing right now" stage label for the in-surface
 * Assist panels (/pages, /tables, /apps, /dev-tools).
 *
 * Same trick as the assistant's turn-stage (lib/assistant/turn-stage.ts): each
 * Assist run is a single blocking POST, but the tracing layer writes the trace
 * row (status='running') and each step row (with a descriptive `name`) at the
 * START of the work, so the current activity is queryable mid-run. The panel
 * polls this (~1×/s) and shows the label, so the user isn't blind while the
 * specialist reads / edits / builds.
 *
 * Every specialist Assist run is invoked via invokeAgent → a `kind='manual'`,
 * `subject_kind='child_agent'` trace tagged with `data.delegated_agent_slug`
 * (see packages/agent-runtime/invoke-agent). We filter by that slug so two
 * surfaces polling at once (or the main assistant delegating in the background)
 * never cross-talk.
 *
 * This generalises the original /apps-only reader (lib/apps/assist-stage.ts):
 * one unified label map works for every specialist because tool slugs are
 * globally unique.
 */
import { db, traces, traceSteps, and, eq, gt, desc, sql } from '@mantle/db';

/** Builds (esbuild + an LLM loop) and batch page/table edits run longer than a
 *  chat turn — widen the staleness guard so a legitimately slow run still shows
 *  a stage, while still hiding a zombie `status='running'` trace's stale label. */
const FRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Map a trace_step `name` to a user-facing label. Step names come from the tool
 * loop (packages/agent-runtime/tool-loop.ts): `<adapter>_chat` (an LLM call) and
 * `tool: <slug>` (a dispatch). One unified map serves every specialist — tool
 * slugs don't collide across Pages / Tables / Apps / Toolsmith.
 *
 * Coarse on purpose: fast CRUD tools flash by under the ~900ms poll, so we only
 * name stages a user actually waits on. Returns null for names we don't surface
 * (the caller falls back to "{name} is working…").
 *
 * NOTE: the labels below depend on the step-name contract from tool-loop.ts. If
 * that naming changes, update this map (asserted by assist-stage.test.ts).
 */
export function specialistStageLabelForStep(name: string): string | null {
  if (!name) return null;
  if (/_chat(\[|$)/.test(name)) return 'Thinking…';
  if (/^spill_result:/.test(name)) return 'Working on it…';

  const tool = /^tool:\s*(.+)$/.exec(name);
  if (!tool) return null;

  switch (tool[1]!.trim()) {
    // ── Base rules — any specialist can hit these ────────────────────────
    case 'invoke_agent':
      return 'Delegating…';
    case 'web_search':
    case 'web_search_pro':
    case 'web_fetch':
      return 'Reading docs…';

    // ── Apps (Appsmith) ──────────────────────────────────────────────────
    case 'app_file_write':
      return 'Writing code…';
    case 'app_file_delete':
      return 'Removing a file…';
    case 'app_build':
      return 'Building…';
    case 'app_get':
      return 'Reading the app…';
    case 'app_create':
      return 'Creating the app…';
    case 'app_tools_set':
      return 'Wiring up tools…';
    case 'app_db_schema_set':
      return 'Setting up storage…';
    case 'app_publish':
      return 'Publishing…';

    // ── Pages ────────────────────────────────────────────────────────────
    case 'page_get':
    case 'page_blocks_list':
    case 'page_block_get':
      return 'Reading the page…';
    case 'page_block_update':
    case 'page_block_insert_after':
    case 'page_update_draft':
      return 'Editing the page…';
    case 'page_block_delete':
      return 'Removing blocks…';
    case 'page_create':
      return 'Creating the page…';
    case 'page_from_file':
    case 'page_replace_from_file':
      return 'Importing the file…';
    case 'page_split':
    case 'page_extract_section':
      return 'Restructuring the page…';

    // ── Tables (Ledger) ──────────────────────────────────────────────────
    case 'table_get':
    case 'table_rows_list':
    case 'table_row_get':
      return 'Reading the table…';
    case 'table_row_add':
    case 'table_row_update':
    case 'table_row_delete':
    case 'table_cell_set':
    case 'table_update':
      return 'Editing the table…';
    case 'table_column_add':
    case 'table_column_update':
    case 'table_column_delete':
      return 'Updating columns…';
    case 'table_set_aggregate':
    case 'table_set_view':
      return 'Computing totals…';
    case 'table_create':
      return 'Creating the table…';
    case 'table_from_text':
    case 'table_from_file':
      return 'Importing data…';
    case 'table_commit':
      return 'Saving…';

    // ── Dev-tools (Toolsmith) ────────────────────────────────────────────
    case 'api_tool_create':
    case 'api_tool_update':
      return 'Writing the tool…';
    case 'api_tool_test':
      return 'Testing the API…';
    case 'api_tool_get':
    case 'api_tool_list':
      return 'Reading your tools…';
    case 'api_tool_delete':
      return 'Removing a tool…';
    case 'api_key_refs':
      return 'Checking vault keys…';
    case 'tool_group_ensure':
    case 'agent_grant_tool_group':
      return 'Granting the tools…';
    case 'tool_group_list':
    case 'agent_list':
      return 'Checking your setup…';

    default:
      return 'Working on it…';
  }
}

/**
 * The owner's current in-flight Assist stage for `agentSlug`, or null when idle.
 * Two tiny indexed single-row reads, filtered by the surface's resolved agent so
 * concurrent runs don't cross-talk. Safe to poll. Soft-fails to null — a tracing
 * hiccup must never break the panel.
 */
export async function currentSpecialistStage(
  ownerId: string,
  agentSlug: string,
): Promise<string | null> {
  try {
    const fresh = new Date(Date.now() - FRESH_WINDOW_MS);
    const [trace] = await db
      .select({ id: traces.id })
      .from(traces)
      .where(
        and(
          eq(traces.ownerId, ownerId),
          eq(traces.kind, 'manual'),
          eq(traces.subjectKind, 'child_agent'),
          eq(traces.status, 'running'),
          gt(traces.startedAt, fresh),
          sql`${traces.data} ->> 'delegated_agent_slug' = ${agentSlug}`,
        ),
      )
      .orderBy(desc(traces.startedAt))
      .limit(1);
    if (!trace) return null;

    const [stepRow] = await db
      .select({ name: traceSteps.name })
      .from(traceSteps)
      .where(eq(traceSteps.traceId, trace.id))
      .orderBy(desc(traceSteps.startedAt))
      .limit(1);
    if (!stepRow) return null;
    return specialistStageLabelForStep(stepRow.name);
  } catch {
    return null;
  }
}
