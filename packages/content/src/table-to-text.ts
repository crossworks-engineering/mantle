/**
 * Render a TableDoc to plaintext markdown — a GFM pipe table — so the brain can
 * index a table the same way it indexes everything else. This is the Tables
 * analog of `docToText` for Pages: the extractor + FTS read this string (via
 * `tables.data_text`), never the structured JSON.
 *
 * Includes a header row, every data row (formula columns resolved, typed cells
 * rendered to readable text), and — when a column has an aggregate — a trailing
 * **Totals** row so "what did the budget add up to?" is answerable from the
 * index. Lossy by design (no colours/widths/options metadata); pure, no DB.
 */
import {
  applyView,
  cellIsEmpty,
  computeAggregate,
  resolveCell,
  type CellValue,
  type Column,
  type TableDoc,
} from './table-model';

function escapeCell(s: string): string {
  // Keep the pipe table well-formed: escape pipes, flatten newlines.
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** Render one resolved cell value to readable text for a column. */
export function formatCellText(value: CellValue, col: Column): string {
  if (cellIsEmpty(value)) return '';
  switch (col.type) {
    case 'checkbox':
      return value ? '✓' : '';
    case 'currency': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      const code = col.format?.currency ?? 'USD';
      const dp = col.format?.decimals ?? 2;
      return `${code} ${n.toFixed(dp)}`;
    }
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      const dp = col.format?.decimals ?? 0;
      return `${n.toFixed(dp)}%`;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      return col.format?.decimals != null ? n.toFixed(col.format.decimals) : String(n);
    }
    case 'multiselect':
      return Array.isArray(value) ? value.join(', ') : String(value);
    default:
      return String(value);
  }
}

export function tableToText(doc: TableDoc, opts: { title?: string } = {}): string {
  const { columns } = doc;
  if (columns.length === 0) return opts.title ?? '';

  const rows = applyView(doc, null); // document order, all rows
  const lines: string[] = [];
  if (opts.title) lines.push(`# ${opts.title}`, '');

  const header = `| ${columns.map((c) => escapeCell(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  lines.push(header, sep);

  for (const row of rows) {
    const cells = columns.map((c) => escapeCell(formatCellText(resolveCell(doc, row, c), c)));
    lines.push(`| ${cells.join(' | ')} |`);
  }

  // Totals row, only when at least one column has an aggregate.
  const aggregates = doc.aggregates ?? {};
  if (Object.keys(aggregates).length > 0) {
    const totals = columns.map((c, idx) => {
      const kind = aggregates[c.id];
      if (!kind || kind === 'none') return idx === 0 ? 'Totals' : '';
      const v = computeAggregate(doc, c.id, kind, rows);
      if (v === null) return '';
      const label = formatCellText(v, c.type === 'formula' ? { ...c, type: 'number' } : c);
      return `${kind}: ${label}`;
    });
    if (totals[0] === '') totals[0] = 'Totals';
    lines.push(`| ${totals.map(escapeCell).join(' | ')} |`);
  }

  return lines.join('\n').trim();
}
