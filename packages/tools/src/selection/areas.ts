/**
 * Tool AREAS: the first word of a tool's slug (`page` for `page_block_update`).
 * The tool map (map.ts) writes one line per area, and this is the one short
 * gloss each line carries: what the area is about, in the brain's own words.
 * On the 2026-10-31 bench a names-only map lost right first tools; with these
 * glosses it matched deferred loading.
 *
 * The one field for them, kept beside the flows (flows.ts), not in the system
 * manifest: the tool loop that renders the map runs in @mantle/runtime, which
 * cannot reach server/web. Brain-authored, never tool-authored, so a remote
 * tool (MCP, OpenAPI, recipe) never writes a gloss. An area with two or more
 * granted tools outside the core needs one (areas.test.ts).
 */
export const TOOL_AREA_GLOSSES: Readonly<Record<string, string>> = {
  access: 'who reads a brain item: its grants and workspaces',
  agent: 'agents: list them, grant tool groups, set thinking effort',
  api: 'HTTP tools, their docs and usage skills, the key vault',
  app: 'mini apps: source, build, publish, snapshots, their own databases',
  circuit: 'piping circuits traced from uploaded drawings',
  contact: 'people in the contacts list, also the email allowlist',
  diagram: 'diagrams and charts: types, guides, render',
  draw: 'whiteboard drawings',
  email: "the owner's email: list, read, send",
  entity: 'people, companies and things in the knowledge graph',
  event: 'calendar events and reminders',
  file: 'uploaded files: create, copy, move, rename',
  folder: 'folders that hold files and pages; the notes tree is `tree`',
  formula: 'saved formulas and calculations',
  journal: "first-person journal entries about the owner's life",
  location: 'saved places, distances, places nearby',
  messenger: 'chats with people: direct chats, groups, send, read',
  model: 'model catalog with prices, and the curated model pools',
  node: 'share or unshare any item by a public link',
  note: 'quick notes',
  openrouter: 'model market data: rankings, benchmarks, task share',
  page: 'rich documents: drafts, blocks, commit, share',
  pdf: 'print to PDF, work on PDF files',
  peer: 'other brains linked to this one: ask them, search them, their tools',
  pending: 'tool calls waiting for approval: list, approve, reject',
  present: 'Present canvases: decks, dashboards, schematics',
  recall: "Recall memory maps and the owner's prompts",
  recipe: 'new tools composed from existing tools',
  run: 'long background runs: plan, state, cancel, audit; server shell commands',
  sandbox: 'isolated Linux sandboxes: create, run commands, move files',
  table: 'typed tables, or database grids: rows, columns, queries',
  task: 'tasks and to-dos',
  telegram: "Telegram messages in the user's own paired chats",
  tool: 'tool groups, and the tools a recipe can use',
  tree: 'the notes tree: its folders and where items sit',
  web: 'search the web, fetch a page, crawl or map a site',
  worker: 'worker groups, or panels, for background runs',
};
