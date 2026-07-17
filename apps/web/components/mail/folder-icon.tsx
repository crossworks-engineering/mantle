import {
  Archive,
  ArchiveX,
  File,
  Folder,
  Inbox,
  Send,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

/**
 * Map an arbitrary IMAP folder name to a sensible icon. Folder names are free
 * text and vary by server (INBOX, INBOX.Sent, [Gmail]/All Mail, Deleted Items,
 * …), so this is best-effort with a generic fallback.
 */
export function folderIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === 'inbox') return Inbox;
  if (n.includes('sent')) return Send;
  if (n.includes('archive') || n.includes('all mail')) return Archive;
  if (n.includes('trash') || n.includes('deleted') || n.includes('bin')) return Trash2;
  if (n.includes('junk') || n.includes('spam')) return ArchiveX;
  if (n.includes('draft')) return File;
  return Folder;
}

/** Short display label for a folder: the leaf segment, with INBOX prettified.
 *  The full path stays available as a `title` attribute at the call site. */
export function folderLabel(name: string): string {
  if (name.toUpperCase() === 'INBOX') return 'Inbox';
  const leaf = name.split(/[./]/).filter(Boolean).pop() ?? name;
  return leaf;
}
