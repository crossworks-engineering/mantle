/**
 * Pure label helpers for the docs reader, shared by the server data layer
 * (prev/next labels) and the client nav (folder/file labels). No 'server-only'
 * marker — safe to import from client components.
 */

/** Prettify a filename or folder segment for display:
 *  strip a leading `NN-`/`NN_`/`NN.` ordering prefix, drop the `.md` extension,
 *  turn dashes/underscores into spaces, and title-case.
 *  `00-index.md` → "Index", `02-concepts` → "Concepts", `the-brain.md` → "The Brain". */
export function prettifyDocLabel(name: string): string {
  const base = name.replace(/\.(md|markdown)$/i, '');
  const noPrefix = base.replace(/^\d+[-_.]/, '');
  const spaced = noPrefix.replace(/[-_]+/g, ' ').trim();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase()) || base;
}

/** Display label for a doc, from the last segment of its collection-relative path. */
export function docLabelFromRelPath(relPath: string): string {
  const last = relPath.split('/').pop() ?? relPath;
  return prettifyDocLabel(last);
}
