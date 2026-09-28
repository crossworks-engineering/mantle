/**
 * A pure helper the Forum archive export (forum/export.ts) still uses. The
 * rest of this module (attachment kinds, review-folder slugs) went with the
 * forum's upload routes in member logins Phase 6.
 */

/** Human-readable size for attachment chips + the agent's context line —
 *  '312 B', '2.1 MB'. One decimal above KB, none below. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
