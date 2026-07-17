/**
 * Pure helpers for forum uploads — no DB imports, so the review/staging logic
 * around them stays unit-testable without a database (the forum-search.ts
 * pattern). The store (forum-uploads.ts) and the routes compose these.
 */

/** Attachment kind union — mirrors ConversationAttachment['kind'] in
 *  @mantle/db (assistant-messages.ts). Kept as a local literal so this module
 *  stays import-free; the store's use sites type-check the assignability. */
export type ForumAttachmentKind = 'image' | 'audio' | 'voice' | 'document' | 'video';

/** Infer the attachment kind for a stored mime type. `voice` is a transport
 *  concept (a Telegram voice note), never inferable from mime — audio bytes
 *  classify as `audio`. Anything unrecognized is a `document` (the neutral
 *  "here's a file" rendering). */
export function attachmentKindForMime(mime: string | null | undefined): ForumAttachmentKind {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base.startsWith('video/')) return 'video';
  return 'document';
}

/** Folder slug for a topic's review folder (`files/review/<slug>/`). Mirrors
 *  @mantle/files slugifyFolder semantics (lowercase, NFKD, non-alnum runs →
 *  one dash, trimmed, capped) — createFolder re-slugifies anyway, this keeps
 *  what we display and what lands on disk identical. Never empty: an
 *  all-punctuation title falls back to 'topic'. */
export function topicFolderSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining marks so 'réview' → 'review', not 're-view' (the accent
    // would otherwise fall into the non-alnum run and split the word).
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return s.length === 0 ? 'topic' : s;
}

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
