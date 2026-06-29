'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  AppWindow,
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
  GitCompare,
  GitMerge,
  Cloud,
  Hammer,
  Layers,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  KeyRound,
  Key,
  Lock,
  Network,
  NotebookPen,
  Palette,
  Radio,
  Search,
  ServerCog,
  Settings,
  Sparkles,
  Table2,
  TerminalSquare,
  User,
  UserCheck,
  Waypoints,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useRealtime } from '@/components/realtime/use-realtime';
import { useAssistantDock } from '@/components/assistant/assistant-dock';

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
  collapsed = false,
}: {
  pendingApprovals: number;
  onNavigate?: () => void;
  /** Icon-rail mode: hide the filter box + labels, show a tooltip hint per item.
   *  The mobile drawer always passes false (it renders expanded). */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // Navigating away from an open assistant minimises it, so the screen you
  // picked is actually visible behind the bubble.
  const { minimize } = useAssistantDock();
  const [query, setQuery] = useState('');
  // Live pending-approval badge: when a tool call is queued/approved/rejected
  // anywhere (a chat turn, a heartbeat fire, a Telegram tap), the realtime
  // bridge pings us and we refetch the server-computed count. No polling.
  useRealtime(['pending_tool_call'], () => router.refresh());

  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { name: 'Dashboard', href: '/', icon: LayoutDashboard, exact: true },
        { name: 'Journal', href: '/journal', icon: NotebookPen },
        { name: 'Email', href: '/inbox', icon: Inbox },
        { name: 'Files', href: '/files', icon: FolderTree },
        { name: 'Notes', href: '/notes', icon: FileText },
        { name: 'Pages', href: '/pages', icon: BookText },
        { name: 'Tables', href: '/tables', icon: Table2 },
        { name: 'Apps', href: '/apps', icon: AppWindow },
        { name: 'Tasks', href: '/tasks', icon: CheckSquare },
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
        { name: 'Microsoft', href: '/settings/microsoft', icon: Cloud },
        { name: 'Calendars', href: '/settings/calendar', icon: CalendarDays },
        { name: 'Profile', href: '/settings/profile', icon: User },
        { name: 'API keys', href: '/settings/keys', icon: Key },
        { name: 'Agents', href: '/settings/agents', icon: Bot },
        { name: 'AI workers', href: '/settings/ai-workers', icon: Cpu },
        { name: 'Embedding', href: '/settings/embedding', icon: Combine },
        { name: 'Local network', href: '/settings/network', icon: Radio },
        { name: 'Tools', href: '/settings/tools', icon: Hammer },
        { name: 'Tool groups', href: '/settings/tool-groups', icon: Layers },
        { name: 'Skills', href: '/settings/skills', icon: Sparkles },
        { name: 'Config', href: '/settings/config', icon: GitCompare },
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
        { name: 'Runners', href: '/runners', icon: ServerCog },
        { name: 'Traces', href: '/traces', icon: Workflow },
        { name: 'Debug', href: '/debug', icon: Activity },
      ],
    },
  ];

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/');

  // Filter by item name (case-insensitive substring), dropping now-empty groups.
  // The filter is an expanded-only affordance — at icon-rail width there's no
  // box to type in, so a collapsed rail always shows the full set.
  const q = query.trim().toLowerCase();
  const visibleGroups =
    collapsed || !q
      ? groups
      : groups
          .map((g) => ({ ...g, items: g.items.filter((i) => i.name.toLowerCase().includes(q)) }))
          .filter((g) => g.items.length > 0);

  const renderItem = (item: NavItem) => {
    const active = isActive(item);
    const Icon = item.icon;
    const hasBadge = item.badge != null && item.badge > 0;
    const className = cn(
      'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:gap-0 group-data-[nav-collapsed=true]/shell:px-0',
      active
        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
    );
    const inner = (
      <>
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
      </>
    );

    const trigger = (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => {
          minimize(); // an open assistant steps aside for the screen you chose
          onNavigate?.();
        }}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? undefined : item.name}
        className={className}
      >
        {inner}
      </Link>
    );

    // Collapsed rail: the label lives in a shadcn tooltip on hover/focus.
    if (collapsed) {
      return (
        <Tooltip key={item.href}>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right" className="flex items-center gap-2">
            {item.name}
            {hasBadge && (
              <span className="rounded bg-primary-foreground/20 px-1 text-[10px] tabular-nums">
                {item.badge! > 99 ? '99+' : item.badge}
              </span>
            )}
          </TooltipContent>
        </Tooltip>
      );
    }
    return trigger;
  };

  return (
    <TooltipProvider delayDuration={0}>
      <nav
        className="flex flex-col gap-4 px-3 py-3 group-data-[nav-collapsed=true]/shell:px-2"
        aria-label="Primary"
      >
        {/* Quick filter — expanded mode only (hidden at icon-rail width). */}
        {!collapsed && (
          <div className="sticky top-0 z-10 -mt-3 -mx-3 bg-sidebar px-3 pb-2 pt-3 group-data-[nav-collapsed=true]/shell:hidden">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                placeholder="Filter menu…"
                aria-label="Filter navigation"
                className="h-9 pl-8 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {visibleGroups.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No matches.</p>
        ) : (
          visibleGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden">
                {group.label}
              </p>
              {group.items.map(renderItem)}
            </div>
          ))
        )}
      </nav>
    </TooltipProvider>
  );
}
