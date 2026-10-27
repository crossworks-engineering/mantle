/**
 * Extractor: Spreadsheet auto-conversion: a workbook file becomes a Tables workbook before extraction.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { extOf, isRetryableReadError } from '@mantle/files';
import { parseSpreadsheetToGrid } from '@mantle/files/sheet-to-grid';
import { recordIngest, step } from '@mantle/tracing';
import { createTable, tableDocFromGrid } from '@mantle/content';
import { envNum } from '@mantle/config';
import { loadFileBytes, loadFileHead } from './file-bytes';

/** Extensions that auto-convert to Table(s) on ingest.
 *
 *  `xml` earns its place only conditionally: most XML is not a plan, so the
 *  grid parse below sniffs the content and a non-MSPDI document falls straight
 *  back out to the ordinary text path. */
const AUTO_TABLE_EXTS = new Set(['xlsx', 'xls', 'csv', 'xml', 'dwf', 'dwg', 'dxf']);

/** Max TABLES a single auto-import will create (sheets × paginated parts). Each
 *  table is its own indexed node, so a huge or many-sheet workbook would fan out
 *  into a burst of extractor runs from one upload. Beyond this we create the
 *  leading tables and log the rest as skipped (the source file stays fully
 *  searchable). An explicit `table_from_file` is user-initiated, not capped. */
const MAX_AUTO_TABLE_TABLES = envNum('MANTLE_MAX_AUTO_TABLE_TABLES');

/**
 * On ingest, turn a spreadsheet file node into typed Table(s) — one per
 * non-empty sheet — published immediately + indexed, so registers land in
 * /tables however the file arrived (Files upload, chat attachment,
 * email/Telegram). Deduped by `data.sourceFileId`: re-ingesting the same file
 * node (re-process, external-edit watcher, version reconcile) never creates a
 * second table. Mirrors the `table_from_file` agent tool's core
 * (parseSheetToGrid → tableDocFromGrid → createTable) so manual and automatic
 * imports yield identical grids. Best-effort + isolated: any failure is logged
 * by the caller and never blocks the text-extraction pass.
 */
export async function maybeAutoTableSpreadsheet(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<void> {
  if (node.type !== 'file') return;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const nameForExt = typeof data.filename === 'string' ? data.filename : node.title;
  const fileExt = extOf(nameForExt);
  if (!AUTO_TABLE_EXTS.has(fileExt)) return;

  // `.xml` is a container, so its place in AUTO_TABLE_EXTS is conditional. Rule
  // out the ~99% that aren't plans from the first 8 KB, before the dedupe query
  // and before reading the file — under the 64 MB cap the alternative is a whole
  // file read to answer a question the root element already answers.
  //
  // Only the ROOT check is safe this early. The full sniff's second signal is
  // the namespace OR a `<Tasks>` element, and `<Tasks>` is not near the top: in a
  // real 25 MB export it sat at byte 114,966. A head-scoped full sniff would
  // answer false for a namespace-less plan and silently skip it.
  if (fileExt === 'xml') {
    const head = await loadFileHead(node);
    // An unreadable head is not evidence — fall through and let the full path
    // decide, exactly as it did before.
    if (head && !(await import('@mantle/files/mspdi')).mspdiRootPresent(head)) return;
  }

  // Dedupe: if a table already references this file, do nothing (re-ingest safe).
  const existing = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'table'),
        sql`${nodes.data}->>'sourceFileId' = ${node.id}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  const loaded = await loadFileBytes(node);
  if (!loaded) return;
  let sheets: Awaited<ReturnType<typeof parseSpreadsheetToGrid>>;
  /** Caveat the reader needs before querying — set only where the grid is
   *  genuinely misleading read the obvious way. */
  let description: string | undefined;
  /** A drawing's table names the bytes it was built from (its revision). */
  let sourceSha256: string | undefined;
  try {
    if (fileExt === 'xml') {
      // Sniffed again, not redundantly: the early check is skipped when the head
      // could not be read, so this is the one that runs for those. It costs a
      // regex over 8 KB of a buffer already in hand.
      const { parseMspdi, sniffMspdi } = await import('@mantle/files/mspdi');
      const plan = sniffMspdi(loaded.bytes) ? parseMspdi(loaded.bytes) : null;
      sheets = plan?.sheets ?? [];
      if (plan) {
        // Only the ROLL-UP sentence is conditional. Gating the whole
        // description on summaryCount left a flat plan — one with no summary
        // rows — with no description at all, losing the unit guidance, which is
        // true of every plan. Correct-looking and quietly less useful.
        const rollup =
          plan.meta.summaryCount > 0
            ? ` ${plan.meta.summaryCount} of ${plan.meta.taskCount} rows in Tasks are summary` +
              ` (roll-up) rows whose work, duration and cost ALREADY include their child tasks —` +
              ` add WHERE "Summary"=0 to any total, or the same work is counted once per outline` +
              ` level.`
            : '';
        description =
          `Microsoft Project plan.${rollup}` +
          ` Durations are hours unless the column says days; slack is in days.` +
          ` Rows are in plan order.`;
      }
    } else if (fileExt === 'dwf') {
      // DWF plot sets: the registry workbook (Sheets / Layers / Labels tabs)
      // from @mantle/files/dwf — on circuitization sets the Layers tab IS the
      // circuit registry. Content-gated on the DWF magic like parse.ts.
      const { sniffDwf, parseDwfToGrids } = await import('@mantle/files/dwf');
      sheets = sniffDwf(loaded.bytes) ? await parseDwfToGrids(loaded.bytes) : [];
      if (sheets.length > 0) {
        description =
          `Autodesk DWF plot-set registry. Layers is the cross-sheet layer/circuit` +
          ` registry; Labels is every annotation string with its occurrence count and` +
          ` sheets. Vector geometry is not in this table — fetch the Source DWG named` +
          ` per row in Sheets for measurements.`;
      }
    } else if (fileExt === 'dwg' || fileExt === 'dxf') {
      // DWG/DXF drawings: the registry workbook (Layers / Texts / Blocks /
      // Counts, and the bones: Segments / Nodes / Inserts / Circuits) from
      // @mantle/files/{dwg,dxf}, sidecar-parsed, so this pass shares the one
      // memoised exchange with the text digest and the image pass. The
      // description says what each tab holds and what it does not.
      const { cadRegistryWorkbook, dwgSourceSha } = await import('@mantle/files/dwg');
      const built = await cadRegistryWorkbook(loaded.bytes, fileExt);
      sourceSha256 = dwgSourceSha(loaded.bytes);
      sheets = built.grids.sheets;
      description = built.description;
    } else {
      sheets = await parseSpreadsheetToGrid(loaded.bytes, fileExt);
    }
  } catch (err) {
    // DWG/DXF: the workbook, the text digest and the image pass all hang off
    // the SAME sidecar exchange. A transient sidecar failure here used to
    // vanish (`return`), the text pass then succeeded against a recovered
    // sidecar, and the node completed WITHOUT its registry table, permanently
    // and silently. Rethrow (flagged for the call site) so the whole extract
    // errors and the pg-boss retry heals all passes together.
    if (fileExt === 'dwg' || fileExt === 'dxf') {
      const e = err instanceof Error ? err : new Error(String(err));
      throw Object.assign(e, { fatalToExtract: true });
    }
    // A grid read that could not run in time (every read slot busy, a first
    // time-out) is retried with the extract, not taken as "no grid".
    if (isRetryableReadError(err)) throw err;
    return; // unparseable as a grid — leave it as a plain file
  }
  if (sheets.length === 0) return;

  // One workbook per spreadsheet (v2.1 P2): every usable sheet becomes a TAB
  // of a single table node — no more sibling-table splitting (the client-box
  // sweep's "129 auto-tables" class shrinks by the sheet multiplier). The cap
  // now bounds TABS per workbook; the vestigial part logic is gone (parts
  // were never set post-v2).
  const toTab = sheets.slice(0, MAX_AUTO_TABLE_TABLES);
  const skipped = sheets.length - toTab.length;
  const base =
    loaded.filename.replace(/\.(xlsx|xls|csv|xml|dwf|dwg|dxf)$/i, '').trim() || 'Imported table';
  await step(
    {
      name: 'auto_table',
      kind: 'compute',
      input: {
        filename: loaded.filename,
        grids: sheets.length,
        creating: toTab.length,
        skipped,
        sourceFileId: node.id,
      },
    },
    async (h) => {
      const tabs = toTab
        .map((sheet, i) => ({
          ...tableDocFromGrid(sheet),
          name: (sheet.name || `Sheet${i + 1}`).slice(0, 100),
        }))
        // Skip grids with no usable tabular data (empty / header-only).
        .filter((t) => t.columns.length > 0 && t.rows.length > 0);
      if (tabs.length === 0) {
        h.setMeta({ created: 0, skipped });
        return [];
      }
      const table = await createTable(ownerId, {
        title: base.slice(0, 200),
        tabs,
        tags: ['auto-import'],
        sourceFileId: node.id,
        ...(sourceSha256 ? { sourceSha256 } : {}),
        ...(description ? { description } : {}),
      });
      void recordIngest({
        source: 'extractor',
        ownerId,
        nodeId: table.id,
        summary: `Auto-imported table from ${loaded.filename} (${tabs.length} tab${tabs.length === 1 ? '' : 's'}): ${table.title}`,
        payload: {
          via: 'auto_table_on_ingest',
          sourceFileId: node.id,
          tabs: tabs.map((t) => t.name),
        },
      });
      h.setMeta({ created: 1, tableIds: [table.id], tabs: tabs.length, skipped });
      return [table.id];
    },
  );
}

// ─── embedded images ──────────────────────────────────────────────────
