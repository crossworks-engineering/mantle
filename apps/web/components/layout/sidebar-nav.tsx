'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bot,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  Cpu,
  FileText,
  FolderTree,
  Hammer,
  HeartPulse,
  Inbox,
  KeyRound,
  Key,
  Lock,
  MessageCircle,
  Palette,
  Settings,
  Sparkles,
  User,
  UserCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

type NavItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
  /** Exact-match only (used for "/" so it doesn't match every route). */
  exact?: boolean;
};

type NavGroup = { label: string; items: NavItem[] };

export function SidebarNav({
  pendingSenders,
  pendingApprovals,
  onNavigate,
}: {
  pendingSenders: number;
  pendingApprovals: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { name: 'Inbox', href: '/', icon: Inbox, exact: true },
        { name: 'Assistant', href: '/assistant', icon: MessageCircle },
        { name: 'Files', href: '/files', icon: FolderTree },
        { name: 'Notes', href: '/notes', icon: FileText },
        { name: 'Todos', href: '/todos', icon: CheckSquare },
        { name: 'Events', href: '/events', icon: CalendarDays },
        { name: 'Secrets', href: '/secrets', icon: Lock },
      ],
    },
    {
      label: 'Review',
      items: [
        { name: 'Senders', href: '/settings/senders', icon: UserCheck, badge: pendingSenders },
        { name: 'Pending', href: '/pending', icon: ClipboardCheck, badge: pendingApprovals },
      ],
    },
    {
      label: 'Settings',
      items: [
        { name: 'Appearance', href: '/settings/appearance', icon: Palette },
        { name: 'Accounts', href: '/settings/accounts', icon: Settings },
        { name: 'Profile', href: '/settings/profile', icon: User },
        { name: 'API keys', href: '/settings/keys', icon: Key },
        { name: 'Agents', href: '/settings/agents', icon: Bot },
        { name: 'AI workers', href: '/settings/ai-workers', icon: Cpu },
        { name: 'Tools', href: '/settings/tools', icon: Hammer },
        { name: 'Skills', href: '/settings/skills', icon: Sparkles },
        { name: 'Heartbeats', href: '/settings/heartbeats', icon: HeartPulse },
        { name: 'Security', href: '/settings/security', icon: KeyRound },
      ],
    },
    {
      label: 'System',
      items: [
        { name: 'Traces', href: '/traces', icon: Workflow },
        { name: 'Debug', href: '/debug', icon: Activity },
      ],
    },
  ];

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/');

  return (
    <nav className="flex flex-col gap-4 px-3 py-3" aria-label="Primary">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active = isActive(item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">{item.name}</span>
                {item.badge != null && item.badge > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[11px]">
                    {item.badge > 99 ? '99+' : item.badge}
                  </Badge>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
