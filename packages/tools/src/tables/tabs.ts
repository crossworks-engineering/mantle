/**
 * Tabs within a workbook: add, rename, delete.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import { applyTableOps } from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { DRAFT_REVIEW_HINT, TABLE_ID_PRE, loadTab } from './common';

export const table_tab_add: BuiltinToolDef = {
  slug: 'table_tab_add',
  preconditions: TABLE_ID_PRE,
  name: 'Add a tab',
  description:
    'Add an empty tab (worksheet) to a table — one table is one workbook; tabs are its sheets, queryable together with `table_sql` joins. Build it out with `table_column_add`/`table_row_add` passing `tab`. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      name: { type: 'string', description: 'Tab name shown on the tab bar, e.g. "Car models".' },
      after_tab: {
        type: 'string',
        description: 'optional tab (name or id) to insert after; omit to append',
      },
    },
    required: ['table_id', 'name'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id and name are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.after_tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const afterTabId = str(input.after_tab).trim() ? loaded.tabId : undefined;
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        { op: 'tab_add', name, ...(afterTabId !== undefined ? { afterTabId } : {}) },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      const tabId = applied.createdIds[0] ?? '';
      ctx.step?.setOutput({ table_id: tableId, tab_id: tabId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          tab_id: tabId,
          name,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_tab_rename: BuiltinToolDef = {
  slug: 'table_tab_rename',
  preconditions: TABLE_ID_PRE,
  name: 'Rename a tab',
  description:
    'Rename a tab (worksheet). Its `table_sql` view name re-derives from the new name; data and row/column ids are untouched. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      tab: { type: 'string', description: 'the tab to rename, by name or id' },
      name: { type: 'string', description: 'new tab name' },
    },
    required: ['table_id', 'tab', 'name'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id, tab and name are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const tabId = loaded.tabId ?? loaded.table.tabId;
    if (!tabId) return { ok: false, error: 'tab is required — name or id from table_get' };
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        { op: 'tab_rename', tabId, name },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, tab_id: tabId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          tab_id: tabId,
          name,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_tab_delete: BuiltinToolDef = {
  slug: 'table_tab_delete',
  preconditions: TABLE_ID_PRE,
  name: 'Delete a tab',
  description:
    'Remove a tab (worksheet) and all its rows/columns from the DRAFT — Discard reverts, Commit makes it permanent. Refuses to delete the last remaining tab; to remove the whole table use `table_delete`.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      tab: { type: 'string', description: 'the tab to delete, by name or id' },
    },
    required: ['table_id', 'tab'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId || !str(input.tab).trim())
      return { ok: false, error: 'table_id and tab are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const tabId = loaded.tabId;
    if (!tabId) return { ok: false, error: `no tab '${str(input.tab)}' on this table` };
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [{ op: 'tab_delete', tabId }]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, tab_id: tabId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          tab_id: tabId,
          deleted: true,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};
