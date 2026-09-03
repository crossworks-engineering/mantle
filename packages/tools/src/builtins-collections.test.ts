import { describe, expect, it } from 'vitest';
import { TABLE_TOOLS, TABLE_TOOL_SLUGS } from './builtins-tables';
import { PAGE_TOOLS, PAGE_TOOL_SLUGS } from './builtins-pages';
import { SANDBOX_TOOLS, SANDBOX_TOOL_SLUGS } from './builtins-sandbox';
import {
  FILE_TOOLS,
  FILE_CREATE_TOOLS,
  FILE_MANAGE_TOOLS,
  FILE_OPERATOR_TOOLS,
} from './builtins-files';
import type { BuiltinToolDef } from './types';

/**
 * The four big tool collections, pinned exactly and in assembly order.
 *
 * builtins-{tables,pages,sandbox,files}.ts were 2530 / 2421 / 996 / 998 lines;
 * each is now a small barrel assembling a subdirectory. Every definition moved
 * to a different file, so the thing that had to survive is WHICH tools each
 * group contains and in what order.
 *
 * These lists are the GRANT: a tool group in the system manifest names one of
 * these arrays, so a definition lost in a merge silently removes an ability
 * from every agent holding that group, and one added widens it with nobody
 * approving. Order matters because BUILTIN_TOOLS is assembled from them in
 * sequence and dispatch resolves first-match.
 *
 * The lists were generated from the assembled arrays and checked against the
 * pre-split files before being written down.
 */
const TABLE_TOOLS_SLUGS = [
  'table_create',
  'table_from_file',
  'table_from_text',
  'table_update',
  'table_delete',
  'table_commit',
  'table_list',
  'table_get',
  'table_schema',
  'table_sql',
  'table_rows_list',
  'table_row_get',
  'table_query',
  'table_aggregate',
  'table_row_add',
  'table_rows_add',
  'table_rows_upsert',
  'table_row_update',
  'table_row_delete',
  'table_cell_set',
  'table_column_add',
  'table_column_update',
  'table_column_delete',
  'table_tab_add',
  'table_tab_rename',
  'table_tab_delete',
  'table_set_aggregate',
  'table_set_view',
] as const;
const PAGE_TOOLS_SLUGS = [
  'page_create',
  'page_from_file',
  'page_from_note',
  'page_from_notes',
  'page_from_journal',
  'page_replace_from_file',
  'page_update',
  'page_update_draft',
  'page_blocks_list',
  'page_block_get',
  'page_block_update',
  'page_block_insert_after',
  'page_block_insert_before',
  'page_block_append',
  'page_block_delete',
  'page_blocks_apply',
  'page_commit',
  'page_discard_draft',
  'page_split',
  'page_extract_section',
  'page_move',
  'page_mention',
  'page_delete',
  'page_list',
  'page_get',
  'page_share',
  'page_unshare',
] as const;
const SANDBOX_TOOLS_SLUGS = [
  'sandbox_create',
  'sandbox_exec',
  'sandbox_list',
  'sandbox_stop',
  'sandbox_rm',
  'sandbox_export',
  'sandbox_import',
  'sandbox_ls',
  'sandbox_autostart',
  'sandbox_publish',
  'sandbox_mcp_tools',
  'sandbox_mcp_call',
] as const;
const FILE_TOOLS_SLUGS = [
  'folder_list',
  'file_list',
  'file_get',
  'file_read',
  'file_rename',
  'folder_rename',
  'folder_describe',
] as const;
const FILE_CREATE_TOOLS_SLUGS = ['file_create', 'folder_get_by_path'] as const;
const FILE_MANAGE_TOOLS_SLUGS = [
  'file_move',
  'file_copy',
  'folder_move',
  'folder_copy',
  'file_set_indexing',
  'folder_set_indexing',
] as const;
const FILE_OPERATOR_TOOLS_SLUGS = [
  'folder_create',
  'folder_delete',
  'file_upload',
  'file_delete',
] as const;

const groups: Array<[string, readonly BuiltinToolDef[], readonly string[]]> = [
  ['TABLE_TOOLS', TABLE_TOOLS, TABLE_TOOLS_SLUGS],
  ['PAGE_TOOLS', PAGE_TOOLS, PAGE_TOOLS_SLUGS],
  ['SANDBOX_TOOLS', SANDBOX_TOOLS, SANDBOX_TOOLS_SLUGS],
  ['FILE_TOOLS', FILE_TOOLS, FILE_TOOLS_SLUGS],
  ['FILE_CREATE_TOOLS', FILE_CREATE_TOOLS, FILE_CREATE_TOOLS_SLUGS],
  ['FILE_MANAGE_TOOLS', FILE_MANAGE_TOOLS, FILE_MANAGE_TOOLS_SLUGS],
  ['FILE_OPERATOR_TOOLS', FILE_OPERATOR_TOOLS, FILE_OPERATOR_TOOLS_SLUGS],
];

describe.each(groups)('%s', (_name, tools, slugs) => {
  it('assembles exactly these tools, in this order', () => {
    expect(tools.map((t) => t.slug)).toEqual([...slugs]);
  });

  it('gives every tool a handler and a name', () => {
    for (const t of tools) {
      expect(typeof t.handler, t.slug).toBe('function');
      expect(t.name, t.slug).toBeTruthy();
    }
  });
});

describe('derived slug lists', () => {
  it('come from the same arrays', () => {
    expect(TABLE_TOOL_SLUGS).toEqual([...TABLE_TOOLS_SLUGS]);
    expect(PAGE_TOOL_SLUGS).toEqual([...PAGE_TOOLS_SLUGS]);
    expect(SANDBOX_TOOL_SLUGS).toEqual([...SANDBOX_TOOLS_SLUGS]);
  });
});

describe('the file groups stay disjoint', () => {
  it('never lists one tool in two groups', () => {
    // FILE_OPERATOR_TOOLS is mcpOnly owner surface; the others are grantable.
    // A slug in both would hand an agent a tool the operator split off.
    const all = [...FILE_TOOLS, ...FILE_CREATE_TOOLS, ...FILE_MANAGE_TOOLS, ...FILE_OPERATOR_TOOLS];
    const seen = new Map<string, number>();
    for (const t of all) seen.set(t.slug, (seen.get(t.slug) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });
});
