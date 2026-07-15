/**
 * fileFamilyKey — group versioned exports of the same document.
 *
 * Weekly report dumps and "_version_NN" workbooks arrive as siblings whose
 * titles differ only in a date / version / sequence token. Retrieval then
 * hits whichever version's chunk is cosine-closest — often a stale one. The
 * extractor uses this key to find a file's family among its siblings and
 * down-weight the OLDER versions' salience (a re-ranking nudge, not a hide:
 * λ·(1−salience) is a small distance penalty, and the files stay fully
 * readable and findable by title).
 *
 * The key: lowercase title, extension stripped, every run of ≥2 digits
 * replaced with '#'. Single digits stay literal on purpose — "unit-1" vs
 * "unit-2" are DIFFERENT documents, while "…_version_02" vs "…_05" and
 * date-stamped exports ("…_260215") are versions. A title with no ≥2-digit
 * run has no version signal → null (never grouped).
 */
export function fileFamilyKey(title: string): string | null {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, ''); // extension
  if (!/\d\d/.test(base)) return null;
  return base.replace(/\d{2,}/g, '#');
}
