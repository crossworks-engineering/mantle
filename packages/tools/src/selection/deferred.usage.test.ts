/**
 * A5 step 6d (gateway survey finding 14): the usage tiers moved from the
 * deferred selection's USAGE_TIERS onto each builtin's definition
 * (`usageTier`). The prior tool_search ranks with is main's, name for name,
 * but for `recall_window`, a tool that no longer exists (no grant can hold
 * it), so the order of every search over any grant is as before.
 */
import { describe, expect, it } from 'vitest';
import '../registry';
import { listBuiltins } from '../registry';
import { buildDeferredToolset, toolUsagePrior, type DeferredToolDef } from './deferred';
import { rankTools, buildToolCards, indexCards } from './rank';

// main's list (v0.300.42), as it was.
const MAIN_USAGE_TIERS: readonly (readonly [number, string])[] = [
  [10, 'search_chunks search_nodes'],
  [9, 'read_result page_block_get table_row_add read_section table_sql'],
  [8, 'page_get page_blocks_list page_block_update'],
  [7, 'file_read invoke_agent model_pool_set web_search table_schema page_list'],
  [
    6,
    'run_terminal node_read table_list page_block_insert_after app_file_write model_catalog app_db_query table_query app_get table_cell_set file_list app_db_list',
  ],
  [
    5,
    'note_get page_create web_fetch event_list table_get folder_list show_image file_get page_blocks_apply table_rows_list recall_match table_from_file entity_search tool_catalog app_build tree_list',
  ],
  [
    4,
    'table_row_update journal_create page_block_append page_update_draft table_aggregate folder_get_by_path note_list peer_query task_create calculate table_rows_add file_create page_delete recall_window recipe_tool_test table_row_get',
  ],
  [
    3,
    'app_db_seed email_get email_list task_list journal_list model_pool_list note_create recipe_tool_create api_tool_create app_publish extract_from_image peer_list table_column_add api_tool_delete app_db_schema_set contact_find page_block_insert_before sandbox_exec api_key_refs generate_image note_update page_move peer_search_chunks',
  ],
  [
    2,
    'entity_facts openrouter_rankings recall_index task_get tree_folder_create tree_item_move web_search_pro table_from_text table_row_delete tool_group_list agent_list api_tool_list api_tool_test export_node openrouter_benchmarks openrouter_task_classes peer_node_get table_column_update table_create table_tab_add tool_group_ensure video_ingest',
  ],
];
const MAIN_PRIOR: Readonly<Record<string, number>> = Object.fromEntries(
  MAIN_USAGE_TIERS.flatMap(([tier, names]) => names.split(' ').map((s) => [s, 2 ** tier] as const)),
);

describe('the usage prior is on the definitions (A5 step 6d)', () => {
  it("equals main's, but the retired recall_window", () => {
    const { recall_window: retired, ...rest } = MAIN_PRIOR;
    expect(retired).toBe(16);
    expect(toolUsagePrior()).toEqual(rest);
    expect(listBuiltins().some((d) => d.slug === 'recall_window')).toBe(false);
  });

  it('ranks every query over the whole grant as main did', () => {
    const defs: DeferredToolDef[] = listBuiltins().map((d) => ({
      type: 'function',
      function: { name: d.slug, description: d.description, parameters: d.inputSchema },
    }));
    const cards = buildToolCards(
      defs.map((d) => ({ slug: d.function.name, description: d.function.description })),
      [],
    );
    const index = indexCards(cards);
    const queries = [
      'send an email',
      'add a row',
      'find a page',
      'make a table',
      'list files',
      'run code',
      'search',
      'note',
    ];
    for (const q of queries) {
      expect(rankTools(index, q, { usage: toolUsagePrior(), limit: 20 })).toEqual(
        rankTools(index, q, { usage: MAIN_PRIOR, limit: 20 }),
      );
    }
    const set = buildDeferredToolset(defs, [])!;
    expect(set.search('send an email').tools.length).toBeGreaterThan(0);
  });
});
