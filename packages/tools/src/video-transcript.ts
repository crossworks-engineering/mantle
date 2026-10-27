/**
 * Pure helpers for `video_ingest`'s transcript page: the duration line and
 * the word count. (The caption-track parser and its garbage heuristic left
 * with the link path, when the media sidecar was removed: the tool now
 * transcribes an uploaded recording's audio only.)
 */

/** Seconds as `m:ss`, or `h:mm:ss` from an hour. */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** Words in a transcript's body, not counting `## [m:ss]` section headings. */
export function transcriptWordCount(markdown: string): number {
  return markdown
    .split('\n')
    .filter((l) => !l.startsWith('## ['))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}
