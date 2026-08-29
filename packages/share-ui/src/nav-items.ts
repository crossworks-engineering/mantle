import {
  Activity,
  AppWindow,
  ArrowUpCircle,
  BookOpen,
  BookText,
  Bot,
  Boxes,
  Cable,
  CalendarDays,
  CheckSquare,
  Container,
  DatabaseBackup,
  ClipboardCheck,
  DoorOpen,
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
  ListTree,
  Key,
  Map,
  Plug,
  Lock,
  Network,
  NotebookPen,
  Palette,
  PenTool,
  Radio,
  ScrollText,
  MessagesSquare,
  ServerCog,
  Settings,
  Sparkles,
  Table2,
  Sigma,
  TerminalSquare,
  User,
  UserCheck,
  Users,
  UsersRound,
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

export type NavGroup = {
  label: string;
  items: NavItem[];
  /**
   * Collapsible groups fold to a usage-ranked *head* — the few destinations
   * this owner actually returns to — with the rest one disclosure away.
   *
   * Which groups get this is a statement about how they're used, not how big
   * they are. Workspace and Review are the daily surfaces and stay whole even
   * though Workspace is the larger of the two; Settings and System are a short
   * head and a long tail, so folding them costs nothing and buys back most of
   * the sidebar's height.
   *
   * Folded, never removed: the sidebar is how someone learns what this product
   * can do, so every destination stays reachable from it without knowing its
   * name.
   */
  collapsible?: boolean;
  /** Items shown when collapsed. Ignored unless `collapsible`. */
  headSize?: number;
  /**
   * Cold-start head, by href, in order — what a brain with no usage history
   * shows. It doubles as the tie-break for equal counts, so a fresh install
   * renders exactly this list and then drifts toward real behaviour without a
   * second code path.
   */
  defaultHead?: string[];
};

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
      { name: 'Recall', href: '/recall', icon: Map },
      { name: 'Draw', href: '/draw', icon: PenTool },
      { name: 'Tables', href: '/tables', icon: Table2 },
      { name: 'Formulas', href: '/formulas', icon: Sigma },
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
      // Was its own 'External' group for this one item — a header earning a row
      // for a single link. It belongs here on the merits anyway: like Team and
      // Discover it's owner-space pointed at people who are not the owner, and
      // it points at the in-shell /team-portal rather than /team (outside the
      // shell, member credential, no way back).
      { name: 'Team Portal', href: '/team-portal', icon: DoorOpen },
    ],
  },
  {
    label: 'Settings',
    // Twenty-four screens, and the owner returns to a handful. Folded to a head
    // of five; the cold-start list is the setup path a new brain walks.
    collapsible: true,
    headSize: 5,
    defaultHead: [
      '/settings/accounts',
      '/settings/profile',
      '/settings/appearance',
      '/settings/agents',
      '/settings/keys',
    ],
    items: [
      { name: 'Appearance', href: '/settings/appearance', icon: Palette },
      { name: 'Accounts', href: '/settings/accounts', icon: Settings },
      { name: 'Microsoft', href: '/settings/microsoft', icon: Cloud },
      { name: 'Calendars', href: '/settings/calendar', icon: CalendarDays },
      { name: 'Profile', href: '/settings/profile', icon: User },
      { name: 'API keys', href: '/settings/keys', icon: Key },
      { name: 'MCP', href: '/settings/mcp', icon: Plug },
      { name: 'Connectors', href: '/settings/connectors', icon: Cable },
      { name: 'Agents', href: '/settings/agents', icon: Bot },
      { name: 'AI workers', href: '/settings/ai-workers', icon: Cpu },
      { name: 'Worker groups', href: '/settings/worker-groups', icon: UsersRound },
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
      // Security was folded into Logins: its password change duplicated the
      // per-login reset, and its device list now reads per login on that screen.
      { name: 'Logins', href: '/settings/users', icon: Users },
      { name: 'Audit log', href: '/settings/audit', icon: ScrollText },
    ],
  },
  {
    label: 'System',
    // Diagnostics and machinery: reached deliberately, never browsed.
    collapsible: true,
    headSize: 3,
    defaultHead: ['/studio', '/traces', '/debug'],
    items: [
      { name: 'Studio', href: '/studio', icon: Waypoints },
      { name: 'API Console', href: '/dev-tools', icon: TerminalSquare },
      { name: 'Runners', href: '/runners', icon: ServerCog },
      // Durable runs surface (docs/runs.md). Nav is a static list with no
      // per-item conditional-visibility mechanism (only the pending badge is
      // dynamic), so this ships always-visible — the System-group siblings
      // (Studio/Runners/Traces/Debug) do the same. It sits next to Debug where
      // the run view used to live as a tab.
      { name: 'Runs', href: '/runs', icon: ListTree },
      // CLI sandboxes (opt-in per box via the `sandboxes` compose profile).
      // Ships always-visible like its gated sibling Runs — the nav is a static
      // list with no per-item conditional-visibility mechanism; the page itself
      // explains how to enable the feature when sandboxd is absent.
      { name: 'Sandboxes', href: '/sandboxes', icon: Container },
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
