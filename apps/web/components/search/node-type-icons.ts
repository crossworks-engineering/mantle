import {
  BookOpen,
  BookText,
  CalendarDays,
  CheckSquare,
  Church,
  Contact,
  File,
  FolderTree,
  Mail,
  Mails,
  NotebookPen,
  Printer,
  Send,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import type { SearchNodeType } from '@/lib/search-query';

/**
 * The one node-type → icon map, keyed off the search API's own type enum so the
 * compiler flags a missing entry whenever `SEARCH_NODE_TYPES` grows. Picks match
 * what nav-items / the journey feed already established for the same content.
 */
export const NODE_TYPE_ICONS: Record<SearchNodeType, LucideIcon> = {
  branch: FolderTree,
  email: Mail,
  email_thread: Mails,
  file: File,
  note: StickyNote,
  page: BookText,
  sermon: Church,
  contact: Contact,
  task: CheckSquare,
  event: CalendarDays,
  printer_project: Printer,
  telegram_message: Send,
  documentation: BookOpen,
  journal: NotebookPen,
};

/** Icon for a node type, tolerating types outside the search enum. */
export function nodeTypeIcon(type: string): LucideIcon {
  return NODE_TYPE_ICONS[type as SearchNodeType] ?? File;
}
