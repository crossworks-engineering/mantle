import {
  Calendar,
  CheckSquare,
  File,
  FileText,
  FileType2,
  Image as ImageIcon,
  KeyRound,
  Mail,
  MessageSquare,
  Send,
  Sparkles,
  StickyNote,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ActionIconKey } from '@/lib/journey-format';

const ICONS: Record<ActionIconKey, LucideIcon> = {
  pdf: FileType2,
  doc: FileText,
  image: ImageIcon,
  file: File,
  email: Mail,
  note: StickyNote,
  event: Calendar,
  task: CheckSquare,
  telegram: Send,
  chat: MessageSquare,
  automation: Sparkles,
  secret: KeyRound,
  tool: Wrench,
};

/** Renders the lucide icon for an action's iconKey. Shared by the Journey
 *  pages and the always-on Activity column. */
export function ActionIcon({ iconKey, className }: { iconKey: ActionIconKey; className?: string }) {
  const Icon = ICONS[iconKey] ?? File;
  return <Icon className={className} />;
}
