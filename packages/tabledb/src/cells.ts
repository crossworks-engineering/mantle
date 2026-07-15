import type { CellValue, ColumnType } from './doc-types';

/**
 * Cell ⇄ SQL storage mapping (plan §3.2):
 *   number/currency/percent → REAL
 *   checkbox                → INTEGER 0/1
 *   date/datetime           → TEXT ISO-8601, normalized on write
 *   multiselect             → TEXT JSON array (json_each-able)
 *   text/select/url         → TEXT
 *   formula                 → never stored
 *
 * Values arrive already coerced by table-model's coerceCell (the doc is the
 * contract), so this layer only maps shapes — EXCEPT dates, which coerceCell
 * historically stored as String(value): normalization to ISO is new here and
 * required for sane ORDER BY / range queries. Unparseable date text is kept
 * verbatim (the P2 profile flags "mixed dates").
 */

export function sqlTypeFor(type: ColumnType): 'REAL' | 'INTEGER' | 'TEXT' {
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
      return 'REAL';
    case 'checkbox':
      return 'INTEGER';
    default:
      return 'TEXT';
  }
}

/** Normalize a date-ish string to ISO. Returns null when it can't be parsed
 *  (caller stores the original text verbatim). Ambiguous slash dates resolve
 *  the way Date.parse does (US month-first) — deterministic, documented. */
export function normalizeDate(raw: string, withTime: boolean): string | null {
  const s = raw.trim();
  if (!s) return null;
  // Already ISO (date or datetime prefix) — cheap path, no TZ surprises.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(s);
  if (isoMatch) {
    if (!withTime) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    return isoMatch[4] ? s.replace(' ', 'T') : `${s}T00:00:00`;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withTime) return date;
  return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Doc cell → SQL bind value. */
export function storeCell(value: CellValue, type: ColumnType): string | number | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(String(value));
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      return value === true || value === 1 || value === 'true' ? 1 : 0;
    case 'multiselect': {
      const arr = Array.isArray(value) ? value.map(String) : [String(value)];
      return arr.length ? JSON.stringify(arr) : null;
    }
    case 'date':
    case 'datetime': {
      const raw = String(value);
      return normalizeDate(raw, type === 'datetime') ?? raw;
    }
    case 'formula':
      return null;
    default: {
      const s = Array.isArray(value) ? value.join(', ') : String(value);
      return s === '' ? null : s;
    }
  }
}

/** SQL value → doc cell. Returns null for SQL NULL (cell omitted). */
export function loadCell(value: unknown, type: ColumnType): CellValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
      return typeof value === 'number' ? value : Number(value);
    case 'checkbox':
      return Number(value) !== 0;
    case 'multiselect': {
      const s = String(value);
      try {
        const parsed = JSON.parse(s) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // legacy / hand-written value — treat as a single option
      }
      return s ? [s] : null;
    }
    default:
      return String(value);
  }
}
