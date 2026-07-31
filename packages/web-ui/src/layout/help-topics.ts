/**
 * Route → help-topic map. The header's "?" button reads this to decide which
 * topic to open; a route with no topic renders no button at all, so coverage
 * can grow screen by screen without anything breaking in between.
 *
 * Matching is LONGEST-PREFIX, so `/settings/agents` beats `/settings`, and a
 * detail route (`/tables/abc-123`) inherits its list route's topic. Keeping the
 * map here — rather than a <SetPageHelp> tag in 80 page files — means the set is
 * exhaustive by construction and checkable in CI (help-topics.test.ts asserts
 * every topic named here has a content file, and vice versa).
 *
 * Topic slugs are file names under `docs/guide/06-help/<topic>.md`.
 */

/** Ordered longest-first at module load, so lookup is a plain scan. */
const ROUTE_TOPICS: ReadonlyArray<readonly [route: string, topic: string]> = [
  // ── Workspace ──────────────────────────────────────────────────────────
  ['/tables', 'tables'],
  ['/pages', 'pages'],
  ['/notes', 'notes'],
  ['/files', 'files'],
  ['/assistant', 'assistant'],
  ['/journal', 'journal'],
  ['/tasks', 'tasks'],
  ['/events', 'events'],
  ['/contacts', 'contacts'],
  ['/secrets', 'secrets'],
  // The mail screen lives at /inbox; the topic keeps the user-facing name.
  ['/inbox', 'inbox'],
  ['/formulas', 'formulas'],
  ['/apps', 'apps'],
  ['/docs', 'docs'],

  // ── Review ─────────────────────────────────────────────────────────────
  ['/models', 'models'],
  ['/settings/discover', 'discover'],
  ['/team-admin', 'team-admin'],
  ['/pending', 'pending'],

  // ── External ───────────────────────────────────────────────────────────
  ['/team-portal', 'team-portal'],

  // ── Settings ───────────────────────────────────────────────────────────
  ['/settings/agents', 'agents'],
  ['/settings/ai-workers', 'ai-workers'],
  ['/settings/tools', 'tools'],
  ['/settings/tool-groups', 'tool-groups'],
  ['/settings/skills', 'skills'],
  ['/settings/keys', 'keys'],
  ['/settings/embedding', 'embedding'],
  ['/settings/heartbeats', 'heartbeats'],
  ['/settings/worker-groups', 'worker-groups'],
  ['/settings/appearance', 'appearance'],
  ['/settings/accounts', 'accounts'],
  ['/settings/microsoft', 'microsoft'],
  ['/settings/calendar', 'calendar'],
  ['/settings/profile', 'profile'],
  ['/settings/mcp', 'mcp'],
  ['/settings/network', 'network'],
  ['/settings/config', 'config'],
  ['/settings/entities', 'entities'],
  ['/settings/peers', 'peers'],
  ['/settings/pdf-passwords', 'pdf-passwords'],
  ['/settings/backups', 'backups'],
  ['/settings/updates', 'updates'],
  ['/settings/security', 'security'],
  ['/settings/users', 'users'],
  ['/settings/audit', 'audit'],

  // ── System ─────────────────────────────────────────────────────────────
  ['/studio', 'studio'],
  ['/dev-tools', 'dev-tools'],
  ['/runners', 'runners'],
  ['/runs', 'runs'],
  ['/sandboxes', 'sandboxes'],
  ['/traces', 'traces'],
  ['/debug', 'debug'],

  // Dashboard. Matched exact-only by the '/' special case below.
  ['/', 'dashboard'],
];

const SORTED = [...ROUTE_TOPICS].sort((a, b) => b[0].length - a[0].length);

/**
 * The help topic for a pathname, or null when the screen has none yet.
 * `/` matches only itself — a bare prefix test would hand it every route.
 */
export function helpTopicForPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const [route, topic] of SORTED) {
    if (route === '/') {
      if (path === '/') return topic;
      continue;
    }
    if (path === route || path.startsWith(`${route}/`)) return topic;
  }
  return null;
}

/** Every topic slug the map references — the CI drift test's left-hand side. */
export function allHelpTopics(): string[] {
  return [...new Set(ROUTE_TOPICS.map(([, topic]) => topic))].sort();
}
