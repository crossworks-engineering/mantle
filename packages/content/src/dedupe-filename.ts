/**
 * Free-name picking for a file landing in a folder that may already hold its
 * name. Pure, no DB imports. Used by the member review (Accept), the member's
 * personal-space uploads and the forum upload filing; it lives here, not in a
 * forum module, so the first two keep it when the forum code is deleted.
 */

/** First filename not in `taken` (case-insensitive): `report.pdf`,
 *  `report-2.pdf`, `report-3.pdf`, … Callers pass the names already present
 *  in the target folder so a second same-named upload files cleanly instead
 *  of tripping upsertFile's collision error. */
export function dedupeFilename(filename: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(filename.toLowerCase())) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}
