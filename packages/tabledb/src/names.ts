/**
 * Identifier hygiene (plan §3.2): physical table/column names are STABLE IDS
 * (renames never rewrite data); display names appear only in the per-tab SQL
 * views, quoted and dedup-suffixed. Leading '_' is reserved for engine tables.
 */

/** Physical name from a stable id: strip to [A-Za-z0-9_]; collisions between
 *  ids that differ only in stripped chars are resolved by the caller via
 *  dedupe(). */
export function physicalName(prefix: 'c' | 't', id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_');
  return `${prefix}_${cleaned || 'x'}`;
}

/** Deterministic dedup: first keeps the name, later duplicates get _2, _3… */
export function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const count = seen.get(k) ?? 0;
    seen.set(k, count + 1);
    return count === 0 ? n : `${n}_${count + 1}`;
  });
}

/** Display name → the label a SQL view exposes. Never empty, never leading
 *  underscore, deduped by the caller; always emitted double-quoted. */
export function viewLabel(name: string): string {
  let label = name.trim();
  if (!label) label = 'Column';
  if (label.startsWith('_')) label = label.replace(/^_+/, '');
  if (!label) label = 'Column';
  return label;
}

/** Quote an identifier for SQLite DDL ("" doubling). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Tab display name → view name: trimmed, non-empty, no leading underscore.
 *  Dedup across tabs is the caller's job (dedupe()). */
export function viewNameForTab(tabName: string): string {
  return viewLabel(tabName || 'Sheet1');
}
