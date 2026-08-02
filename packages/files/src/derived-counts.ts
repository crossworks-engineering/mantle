/**
 * Pure shaping for "what did this file produce?" counts.
 *
 * Ingest spawns derived nodes linked to their source document only through
 * `data.sourceFileId` (JSONB, no FK): extracted images are file nodes, auto
 * imports are table nodes, and the *_from_file tools mint pages/notes/tables.
 * The delete path groups them into user-facing buckets so a refusal can say
 * "this file produced 34 images and 2 tables" instead of a bare count.
 *
 * Kept pure (no DB) so the bucket mapping and phrasing are unit-testable;
 * `countDerivedFromFile` in ops.ts runs the actual GROUP BY.
 */

export type DerivedCounts = {
  images: number;
  tables: number;
  pages: number;
  notes: number;
  other: number;
  total: number;
};

export function emptyDerivedCounts(): DerivedCounts {
  return { images: 0, tables: 0, pages: 0, notes: 0, other: 0, total: 0 };
}

/** Which user-facing bucket a derived node of this type lands in. A derived
 *  `file` node is always an extracted image — the only file-spawning path. */
export function derivedBucketForType(type: string): Exclude<keyof DerivedCounts, 'total'> {
  switch (type) {
    case 'file':
      return 'images';
    case 'table':
      return 'tables';
    case 'page':
      return 'pages';
    case 'note':
      return 'notes';
    default:
      return 'other';
  }
}

export function derivedCountsOf(rows: Array<{ kind: string; n: number }>): DerivedCounts {
  const counts = emptyDerivedCounts();
  for (const row of rows) {
    counts[derivedBucketForType(row.kind)] += row.n;
    counts.total += row.n;
  }
  return counts;
}

/** "34 images, 2 tables and 1 note" — for refusal messages and confirm UIs. */
export function describeDerivedCounts(counts: DerivedCounts): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (counts.images) parts.push(plural(counts.images, 'image', 'images'));
  if (counts.tables) parts.push(plural(counts.tables, 'table', 'tables'));
  if (counts.pages) parts.push(plural(counts.pages, 'page', 'pages'));
  if (counts.notes) parts.push(plural(counts.notes, 'note', 'notes'));
  if (counts.other) parts.push(plural(counts.other, 'other node', 'other nodes'));
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
