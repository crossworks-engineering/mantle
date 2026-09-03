/**
 * The query and aggregate surface: filtering, grouping and rollups over
 * rows without pulling them all back.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import {
  computeAggregate,
  groupRows,
  queryRows,
  resolveCell,
  AGGREGATE_KINDS,
  FILTER_OPS,
  type AggregateKind,
  type CellValue,
  type Column,
  type Filter,
  type SortSpec,
} from '@mantle/content';
import { aggregateWindow, queryRowsWindow } from '@mantle/tabledb';
import type { BuiltinToolDef } from '../types';
import { str, strArr } from '../coerce';
import { TABLE_ID_PRE, TAB_HINT, loadTab, pageMeta, resolveColumn, windowFile } from './common';

export const table_query: BuiltinToolDef = {
  slug: 'table_query',
  readOnly: true,
  preconditions: TABLE_ID_PRE,
  name: 'Query rows by value',
  description:
    'Find the rows matching `filters` — the structured-lookup tool for questions about a specific record or subset of a big grid. Returns ONLY the matching rows (id + cells keyed by column name, formula columns resolved) plus `total_matches`, so "what\'s the design pressure for circuit 17-P08-D17003" is one call, not a page-through. Filters AND by default — pass `match: "any"` to OR them. Pass `aggregate` to compute totals over the WHOLE matched set without reading the rows back. **`rows` caps at 500 per call; `total_matches` is exact — use it for COUNTS, and page with `offset` (`truncated`/`next_offset` announce clipping).** Read-only — nothing is saved (unlike `table_set_view`). Reads the draft if one exists. For grouped breakdowns ("count by metallurgy") use `table_aggregate`.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      filters: {
        type: 'array',
        description: 'predicates over columns; AND-ed unless match="any"',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            op: {
              type: 'string',
              enum: [...FILTER_OPS],
              description:
                'How the cell compares to `value`. contains is case-insensitive; ordered comparisons never match empty cells.',
            },
            value: { description: 'compared against the cell (omit for empty/notEmpty)' },
          },
          required: ['column', 'op'],
        },
      },
      match: {
        type: 'string',
        enum: ['all', 'any'],
        description: "combine filters with AND ('all', default) or OR ('any')",
      },
      sort: {
        type: 'array',
        description:
          'Order the matched rows before paging, e.g. [{ "column": "Price", "dir": "desc" }].',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'Column to sort by (id or name).' },
            dir: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort direction — defaults to ascending.',
            },
          },
          required: ['column'],
        },
      },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'restrict returned cells to these columns (id or name)',
      },
      aggregate: {
        type: 'array',
        description: 'compute totals over the full matched set (not just the returned page)',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            kind: {
              type: 'string',
              enum: AGGREGATE_KINDS.filter((k) => k !== 'none'),
              description:
                'The summary to compute. Numeric kinds skip non-numeric cells; filled/empty count cells.',
            },
          },
          required: ['column', 'kind'],
        },
      },
      offset: {
        type: 'number',
        description: "Matching rows to skip for paging — pass the previous call's `next_offset`.",
      },
      limit: { type: 'number', description: 'max matching rows to return (default 50, max 500)' },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { table, doc, tabId } = loaded;

    const ignoredFilters: string[] = [];
    const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
      .map((f): Filter | null => {
        const rec = f as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        if (!col) {
          ignoredFilters.push(str(rec.column));
          return null;
        }
        return {
          colId: col.id,
          op: str(rec.op) as Filter['op'],
          value: (rec.value ?? null) as CellValue,
        };
      })
      .filter((f): f is Filter => f !== null);
    const sort: SortSpec[] = (Array.isArray(input.sort) ? input.sort : [])
      .map((s): SortSpec | null => {
        const col = resolveColumn(doc, str((s as Record<string, unknown>).column));
        return col
          ? { colId: col.id, dir: (s as Record<string, unknown>).dir === 'desc' ? 'desc' : 'asc' }
          : null;
      })
      .filter((s): s is SortSpec => s !== null);
    const match = str(input.match) === 'any' ? 'any' : 'all';
    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = Math.max(1, Math.min(typeof input.limit === 'number' ? input.limit : 50, 500));

    const wantCols = strArr(input.columns)
      .map((c) => resolveColumn(doc, c))
      .filter((c): c is Column => c !== null);
    const projCols = wantCols.length ? wantCols : doc.columns;

    // SQL pushdown (P3): file-backed + no formula columns + parity-safe
    // filters/sort → the query runs in SQLite (draft-first) and never
    // materializes the doc. Falls back to the doc path otherwise; a clipped
    // table whose filters can't push down errors with the recovery move.
    const hasFormula = doc.columns.some((c) => c.type === 'formula');
    const file = hasFormula ? null : await windowFile(ctx.ownerId, tableId);
    const aggSpecs = (Array.isArray(input.aggregate) ? input.aggregate : []).map(
      (a): { col: Column; kind: AggregateKind; raw: string } | null => {
        const rec = a as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        const kind = str(rec.kind) as AggregateKind;
        if (!col || !AGGREGATE_KINDS.includes(kind) || kind === 'none') return null;
        return { col, kind, raw: str(rec.column) };
      },
    );
    const ignoredAggregates = (Array.isArray(input.aggregate) ? input.aggregate : [])
      .map((a, i) => (aggSpecs[i] ? null : str((a as Record<string, unknown>).column)))
      .filter((x): x is string => x !== null);
    const validAggs = aggSpecs.filter((a): a is NonNullable<typeof a> => a !== null);

    let totalMatches: number;
    let pageRows: { id: string; cells: Record<string, CellValue> }[];
    let aggregates: { column: string; kind: AggregateKind; value: number | null }[];
    const pushed = file
      ? queryRowsWindow(file, { filters, match, sort, offset, limit, ...(tabId ? { tabId } : {}) })
      : null;
    if (pushed) {
      totalMatches = pushed.total;
      pageRows = pushed.rows.map((r) => {
        const cells: Record<string, CellValue> = {};
        for (const col of projCols) cells[col.name] = r.cells[col.id] ?? null;
        return { id: r.id, cells };
      });
      aggregates = validAggs.map((a) => ({
        column: a.col.name,
        kind: a.kind,
        value: aggregateWindow(file!, {
          columnId: a.col.id,
          kind: a.kind,
          filters,
          match,
          ...(tabId ? { tabId } : {}),
        }),
      }));
    } else {
      if (table.docClipped) {
        return {
          ok: false,
          error:
            'these filters cannot run in SQL and the table is too large to load whole — simplify the filters ' +
            '(eq/neq/contains on text columns, ranges on number/date columns), or use table_sql for the lookup.',
        };
      }
      const matched = queryRows(doc, { filters, sort, match });
      totalMatches = matched.length;
      pageRows = matched.slice(offset, offset + limit).map((r) => {
        const cells: Record<string, CellValue> = {};
        for (const col of projCols) cells[col.name] = resolveCell(doc, r, col);
        return { id: r.id, cells };
      });
      // Aggregates over the FULL matched set (not the returned page) — so
      // "max design pressure among CS circuits" is one call, cap-immune.
      aggregates = validAggs.map((a) => ({
        column: a.col.name,
        kind: a.kind,
        value: computeAggregate(doc, a.col.id, a.kind, matched),
      }));
    }
    const rows = pageRows;
    const matchedCount = totalMatches;

    ctx.step?.setOutput({ table_id: tableId, matches: matchedCount, pushed: !!pushed });
    return {
      ok: true,
      output: {
        table_id: tableId,
        total_matches: matchedCount,
        offset,
        limit,
        columns: projCols.map((c) => c.name),
        rows,
        ...(aggregates.length ? { aggregates } : {}),
        ...pageMeta(matchedCount, offset, rows.length),
        ...(ignoredFilters.length ? { ignored_filters: ignoredFilters } : {}),
        ...(ignoredAggregates.length ? { ignored_aggregates: ignoredAggregates } : {}),
      },
    };
  },
};

export const table_aggregate: BuiltinToolDef = {
  slug: 'table_aggregate',
  readOnly: true,
  preconditions: TABLE_ID_PRE,
  name: 'Group + summarise rows',
  description:
    'Summarise a table by category — the GROUP BY tool. Rows are bucketed by their combined `group_by` value(s); each group returns its row `count` plus any `metrics` you ask for. Optional `filters` restrict the rows first, `sort` orders the groups (default: most populous first), and `limit`/`offset` page the groups. Answers "how many circuits per metallurgy", "max design pressure by service", or "what distinct damage types exist" (`group_by` alone) in ONE call — no row paging. For the matching rows themselves use `table_query`. Read-only; reads the draft if present.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      group_by: {
        type: 'array',
        items: { type: 'string' },
        description: 'column(s) to group by (id or name)',
      },
      tab: { type: 'string', description: TAB_HINT },
      metrics: {
        type: 'array',
        description: 'per-group aggregates to compute',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            kind: {
              type: 'string',
              enum: AGGREGATE_KINDS.filter((k) => k !== 'none'),
              description:
                'The summary to compute. Numeric kinds skip non-numeric cells; filled/empty count cells.',
            },
          },
          required: ['column', 'kind'],
        },
      },
      filters: {
        type: 'array',
        description: 'restrict rows before grouping (AND-ed unless match="any")',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            op: {
              type: 'string',
              enum: [...FILTER_OPS],
              description:
                'How the cell compares to `value`. contains is case-insensitive; ordered comparisons never match empty cells.',
            },
            value: { description: 'compared against the cell (omit for empty/notEmpty)' },
          },
          required: ['column', 'op'],
        },
      },
      match: {
        type: 'string',
        enum: ['all', 'any'],
        description: "combine filters with AND ('all', default) or OR ('any')",
      },
      sort: {
        type: 'object',
        description: 'How to order the groups — defaults to most populous first.',
        properties: {
          by: { type: 'string', description: "'count', a group column, or a metric column" },
          dir: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction — defaults to descending.',
          },
        },
      },
      offset: {
        type: 'number',
        description: "Groups to skip for paging — pass the previous call's `next_offset`.",
      },
      limit: { type: 'number', description: 'max groups to return (default 50, max 500)' },
    },
    required: ['table_id', 'group_by'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { table, doc } = loaded;
    if (table.docClipped) {
      return {
        ok: false,
        error:
          'this table is too large to group in memory — use table_sql, e.g. ' +
          'SELECT "Column", count(*) FROM "<view>" GROUP BY 1 ORDER BY 2 DESC (table_get\'s sql block lists the views/columns).',
      };
    }

    const groupCols = strArr(input.group_by)
      .map((r) => resolveColumn(doc, r))
      .filter((c): c is Column => c !== null);
    if (groupCols.length === 0)
      return { ok: false, error: 'group_by must name at least one existing column' };

    const ignoredFilters: string[] = [];
    const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
      .map((f): Filter | null => {
        const rec = f as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        if (!col) {
          ignoredFilters.push(str(rec.column));
          return null;
        }
        return {
          colId: col.id,
          op: str(rec.op) as Filter['op'],
          value: (rec.value ?? null) as CellValue,
        };
      })
      .filter((f): f is Filter => f !== null);
    const match = str(input.match) === 'any' ? 'any' : 'all';

    const metricSpecs = (Array.isArray(input.metrics) ? input.metrics : [])
      .map((m): { colId: string; column: string; kind: AggregateKind } | null => {
        const rec = m as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        const kind = str(rec.kind) as AggregateKind;
        return col && AGGREGATE_KINDS.includes(kind) && kind !== 'none'
          ? { colId: col.id, column: col.name, kind }
          : null;
      })
      .filter((m): m is { colId: string; column: string; kind: AggregateKind } => m !== null);

    const buckets = groupRows(doc, { groupColIds: groupCols.map((c) => c.id), filters, match });
    type Group = {
      key: Record<string, CellValue>;
      count: number;
      metrics?: { column: string; kind: AggregateKind; value: number | null }[];
    };
    let groups: Group[] = buckets.map((b) => ({
      key: Object.fromEntries(groupCols.map((c, i) => [c.name, b.key[i] ?? null])),
      count: b.rows.length,
      ...(metricSpecs.length
        ? {
            metrics: metricSpecs.map((m) => ({
              column: m.column,
              kind: m.kind,
              value: computeAggregate(doc, m.colId, m.kind, b.rows),
            })),
          }
        : {}),
    }));

    // Order the groups. Default = most populous first; or by an explicit
    // { by, dir } over count / a group column / a named metric.
    const sortRec =
      input.sort && typeof input.sort === 'object' ? (input.sort as Record<string, unknown>) : null;
    const by = sortRec ? str(sortRec.by) || 'count' : 'count';
    const sign = sortRec && str(sortRec.dir) === 'asc' ? 1 : -1;
    groups = [...groups].sort((a, b) => {
      let va: CellValue, vb: CellValue;
      if (by === 'count') {
        va = a.count;
        vb = b.count;
      } else if (metricSpecs.some((m) => m.column === by)) {
        va = a.metrics?.find((x) => x.column === by)?.value ?? null;
        vb = b.metrics?.find((x) => x.column === by)?.value ?? null;
      } else if (groupCols.some((c) => c.name === by)) {
        va = a.key[by] ?? null;
        vb = b.key[by] ?? null;
      } else {
        return 0;
      }
      const na = typeof va === 'number' ? va : null;
      const nb = typeof vb === 'number' ? vb : null;
      const cmp =
        na !== null && nb !== null ? na - nb : String(va ?? '').localeCompare(String(vb ?? ''));
      return sign * cmp;
    });

    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(input.limit, 500)) : 50;
    const total = groups.length;
    const page = groups.slice(offset, offset + limit);

    ctx.step?.setOutput({ table_id: tableId, groups: total });
    return {
      ok: true,
      output: {
        table_id: tableId,
        group_by: groupCols.map((c) => c.name),
        total_groups: total,
        offset,
        groups: page,
        ...pageMeta(total, offset, page.length),
        ...(ignoredFilters.length ? { ignored_filters: ignoredFilters } : {}),
      },
    };
  },
};

// ───────────────────────── row edits (→ draft) ─────────────────────────
