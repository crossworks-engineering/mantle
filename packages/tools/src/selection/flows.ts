/**
 * Tool FLOWS: a small, fixed set of task-shaped categories over the tool
 * groups ("write a page", "tables and numbers", ...). A flow is what a model
 * scans first when it has to find a tool it does not hold in full: the
 * catalog lists every granted tool by NAME under its flow, and `tool_search`
 * ranks inside it. Flows are derived from the grant (group slug -> flow), so
 * nothing here is stored per agent and a new group only needs one line.
 *
 * PROTOTYPE (tool selection research, 2026-10-05). Not wired into a turn.
 */

export type ToolFlow = {
  slug: string;
  /** Short, task-shaped title the model reads in the catalog. */
  title: string;
  /** One line on when to look here. Brain-authored, never tool-authored. */
  when: string;
  groups: readonly string[];
};

export const TOOL_FLOWS: readonly ToolFlow[] = [
  {
    slug: 'find',
    title: 'Find and read what the brain knows',
    when: 'questions about stored content, documents, people, past chats, memory maps',
    groups: [
      'memory-core',
      'recall-read',
      'recall-write',
      'replay',
      'replay-search',
      'tool-results',
      'curation',
      'brain-health',
    ],
  },
  {
    slug: 'pages',
    title: 'Write or edit a page',
    when: 'create, draft, edit blocks of, share or export a page or document',
    groups: ['pages', 'pages-draft', 'page-share', 'page-admin', 'export', 'draw-read', 'sharing'],
  },
  {
    slug: 'files',
    title: 'Files and folders',
    when: 'list, read, create, move or ingest files, folders, videos',
    groups: ['files', 'ingest', 'video-ingest', 'tables-import'],
  },
  {
    slug: 'tables',
    title: 'Tables, numbers and spreadsheets',
    when: 'typed tables, rows, SQL over data, spreadsheets, formulas, exact maths, app data',
    groups: [
      'tables',
      'tables-read',
      'tables-rows',
      'table-admin',
      'spreadsheets',
      'formulas',
      'formulas-eval',
      'formulas-admin',
      'calculator',
      'app-data',
    ],
  },
  {
    slug: 'plan',
    title: 'Notes, tasks, calendar and journal',
    when: 'save a note, add a task or todo, reminders and events, journal entries, background runs',
    groups: ['notes', 'tasks', 'events', 'journal', 'journal-admin', 'runs'],
  },
  {
    slug: 'people',
    title: 'People, email and messages',
    when: 'contacts, send or read email, Telegram messages, team member chats',
    groups: [
      'contacts',
      'contacts-admin',
      'email',
      'messaging',
      'team-admin',
      'team-read',
      'team-read-admin',
      'client-read',
      'my-space-write',
    ],
  },
  {
    slug: 'web',
    title: 'Web, research and media',
    when: 'search or fetch the web, crawl a site, images, speech, summaries',
    groups: ['research', 'web-read', 'crawl', 'media-workers'],
  },
  {
    slug: 'places',
    title: 'Places and maps',
    when: 'where am I, places nearby, directions, distances, time zone',
    groups: ['location', 'profile'],
  },
  {
    slug: 'delegate',
    title: 'Hand work to a specialist or another brain',
    when: "large authoring jobs, research, apps, diagrams; other people's Mantles",
    groups: ['delegation', 'federation', 'federation-write'],
  },
  {
    slug: 'apps',
    title: 'Mini apps',
    when: 'build, edit, publish or snapshot a mini app',
    groups: ['apps', 'app-admin'],
  },
  {
    slug: 'admin',
    title: 'Settings, secrets and tooling',
    when: 'store a secret, persona calibration, model pools, HTTP tools, access levels, sandboxes',
    groups: [
      'secrets',
      'persona',
      'model-curation',
      'toolsmith',
      'access',
      'sandboxes',
      'terminal',
    ],
  },
];

const FLOW_BY_GROUP = new Map<string, string>(
  TOOL_FLOWS.flatMap((f) => f.groups.map((g) => [g, f.slug] as const)),
);

/** The flow a group belongs to; unknown (custom, MCP) groups land in `other`. */
export function flowForGroup(groupSlug: string): string {
  return FLOW_BY_GROUP.get(groupSlug) ?? 'other';
}

/** The flow of a manifest-style group, or null for a group no flow holds (an
 *  owner's API integration, an MCP or OpenAPI connector). */
export function knownFlowForGroup(groupSlug: string): string | null {
  return FLOW_BY_GROUP.get(groupSlug) ?? null;
}
