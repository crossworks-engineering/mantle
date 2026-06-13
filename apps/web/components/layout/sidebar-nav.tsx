'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  ArrowUpCircle,
  BookOpen,
  BookText,
  Bot,
  Boxes,
  CalendarDays,
  CheckSquare,
  DatabaseBackup,
  ClipboardCheck,
  Contact,
  Cpu,
  Combine,
  FileText,
  FolderTree,
  GitMerge,
  Hammer,
  Layers,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  KeyRound,
  Key,
  Lock,
  MessageCircle,
  Network,
  NotebookPen,
  Palette,
  Radio,
  Settings,
  Sparkles,
  Table2,
  TerminalSquare,
  User,
  UserCheck,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useRealtime } from '@/components/realtime/use-realtime';

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
  pendingApprovals,
  onNavigate,
}: {
  pendingApprovals: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // Live pending-approval badge: when a tool call is queued/approved/rejected
  // anywhere (a chat turn, a heartbeat fire, a Telegram tap), the realtime
  // bridge pings us and we refetch the server-computed count. No polling.
  useRealtime(['pending_tool_call'], () => router.refresh());

  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { name: 'Dashboard', href: '/', icon: LayoutDashboard, exact: true },
        { name: 'Life Logs', href: '/lifelog', icon: NotebookPen },
        { name: 'Email', href: '/inbox', icon: Inbox },
        { name: 'Assistant', href: '/assistant', icon: MessageCircle },
        { name: 'Files', href: '/files', icon: FolderTree },
        { name: 'Notes', href: '/notes', icon: FileText },
        { name: 'Pages', href: '/pages', icon: BookText },
        { name: 'Tables', href: '/tables', icon: Table2 },
        { name: 'Todos', href: '/todos', icon: CheckSquare },
        { name: 'Events', href: '/events', icon: CalendarDays },
        { name: 'Contacts', href: '/contacts', icon: Contact },
        { name: 'Secrets', href: '/secrets', icon: Lock },
        { name: 'Docs', href: '/docs', icon: BookOpen },
      ],
    },
    {
      label: 'Review',
      items: [
        { name: 'Models', href: '/models', icon: Boxes },
        { name: 'Discover', href: '/settings/discover', icon: UserCheck },
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
        { name: 'Embedding', href: '/settings/embedding', icon: Combine },
        { name: 'Local network', href: '/settings/network', icon: Radio },
        { name: 'Tools', href: '/settings/tools', icon: Hammer },
        { name: 'Tool groups', href: '/settings/tool-groups', icon: Layers },
        { name: 'Skills', href: '/settings/skills', icon: Sparkles },
        { name: 'Heartbeats', href: '/settings/heartbeats', icon: HeartPulse },
        { name: 'Entities', href: '/settings/entities', icon: GitMerge },
        { name: 'Peers', href: '/settings/peers', icon: Network },
        { name: 'PDF passwords', href: '/settings/pdf-passwords', icon: Lock },
        { name: 'Backups', href: '/settings/backups', icon: DatabaseBackup },
        { name: 'Updates', href: '/settings/updates', icon: ArrowUpCircle },
        { name: 'Security', href: '/settings/security', icon: KeyRound },
      ],
    },
    {
      label: 'System',
      items: [
        { name: 'Studio', href: '/studio', icon: Waypoints },
        { name: 'API Console', href: '/dev-tools', icon: TerminalSquare },
        { name: 'Traces', href: '/traces', icon: Workflow },
        { name: 'Debug', href: '/debug', icon: Activity },
      ],
    },
  ];

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/');

  // Collapsed (icon-rail) styling is driven entirely by the shell root's
  // `data-nav-collapsed` via `group-data-[…]/shell:` — no prop needed, and the
  // portaled mobile drawer (outside the group) always renders expanded.
  return (
    <nav
      className="flex flex-col gap-4 px-3 py-3 group-data-[nav-collapsed=true]/shell:px-2"
      aria-label="Primary"
    >
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active = isActive(item);
            const Icon = item.icon;
            const hasBadge = item.badge != null && item.badge > 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                title={item.name}
                className={cn(
                  'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:gap-0 group-data-[nav-collapsed=true]/shell:px-0',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate group-data-[nav-collapsed=true]/shell:hidden">
                  {item.name}
                </span>
                {hasBadge && (
                  <>
                    <Badge
                      variant="secondary"
                      className="h-5 min-w-5 justify-center px-1.5 text-[11px] group-data-[nav-collapsed=true]/shell:hidden"
                    >
                      {item.badge! > 99 ? '99+' : item.badge}
                    </Badge>
                    {/* Collapsed: a dot stands in for the count. */}
                    <span
                      className="absolute right-1.5 top-1.5 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[nav-collapsed=true]/shell:block"
                      aria-hidden
                    />
                  </>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
