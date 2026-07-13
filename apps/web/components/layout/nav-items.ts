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
  Plug,
  Lock,
  Network,
  NotebookPen,
  Palette,
  Radio,
  ScrollText,
  MessagesSquare,
  ServerCog,
  Settings,
  Sparkles,
  Table2,
  TerminalSquare,
  User,
  UserCheck,
  Users,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

/**
 * Single source of truth for the primary navigation. Consumed by the sidebar
 * (grouped, with a live pending-approvals badge injected at render) and the
 * footer quick-menu (flat, ranked by usage). Keeping one list here stops the two
 * surfaces from drifting apart.
 */
export type NavItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Exact-match only (used for "/" so it doesn't match every route). */
  exact?: boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
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
      { name: 'Team', href: '/team-admin', icon: MessagesSquare },
      { name: 'Pending', href: '/pending', icon: ClipboardCheck },
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
      { name: 'MCP', href: '/settings/mcp', icon: Plug },
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
      { name: 'Users', href: '/settings/users', icon: Users },
      { name: 'Audit log', href: '/settings/audit', icon: ScrollText },
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

/** Flat list of every nav item, in sidebar order. */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Does `pathname` fall under `item`? Exact items match only their own href. */
export function navItemMatches(item: NavItem, pathname: string): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + '/');
}

/**
 * The canonical nav item for a pathname (most specific href wins, so
 * /settings/agents beats a hypothetical /settings). Used to attribute a visit to
 * exactly one menu for usage ranking.
 */
export function matchNavItem(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of ALL_NAV_ITEMS) {
    if (navItemMatches(item, pathname) && (!best || item.href.length > best.href.length)) {
      best = item;
    }
  }
  return best;
}
