import type { WorkbookTabRef } from './engine';

/**
 * Data dictionary for a workbook, rendered as markdown — the `schema` chunk
 * the brain embeds for every file-backed table (Tables v2.1 P3) and the body
 * `table_schema` returns. The profile chunks carry value distributions; this
 * chunk carries the QUERY SURFACE — tab/column names, types, view + FTS shadow
 * names — so a retrieval hit grounds a table_sql call without a table_get
 * round-trip.
 */
export function schemaToText(
  tabs: WorkbookTabRef[],
  opts: { title: string; nodeId?: string },
): string {
  const lines: string[] = [`# ${opts.title} — table schema`];
  if (opts.nodeId) lines.push(`Table id: ${opts.nodeId}`);
  lines.push(
    `Tabs: ${tabs.map((t) => `${t.name} (${t.rowCount} rows × ${t.columns.length} cols)`).join(', ') || 'none'}. ` +
      'Query with table_sql — read-only SELECT over the views below; FTS MATCH terms need double quotes.',
  );
  for (const t of tabs) {
    lines.push(`## ${t.name}`);
    lines.push(
      `View "${t.viewName}"${t.ftsTable ? ` · FTS shadow ${t.ftsTable}` : ''} · ${t.rowCount} rows.`,
    );
    lines.push(`Columns: ${t.columns.map((c) => `${c.name} (${c.type})`).join(', ') || 'none'}.`);
    const edges = t.columns.filter((c) => c.refersTo);
    for (const c of edges) {
      lines.push(
        `Join edge: "${t.name}"."${c.name}" references "${c.refersTo!.tab}"."${c.refersTo!.column}" — join the views on these columns.`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * One-line schema digest for the corpus map: tab names with shape plus leading
 * column names, hard-capped so the map block stays byte-lean. Changes only when
 * the workbook shape changes (it re-renders on extract), so the corpus-map
 * bytes stay prompt-cache-stable between edits.
 */
export function schemaDigest(tabs: WorkbookTabRef[], maxChars = 140): string {
  const parts = tabs.map((t) => {
    const cols = t.columns.map((c) => c.name).join(', ');
    return `${t.name}(${t.rowCount}r): ${cols}`;
  });
  const joined = parts.join(' · ');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}
