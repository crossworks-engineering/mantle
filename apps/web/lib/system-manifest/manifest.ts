/**
 * The system manifest — the single declarative source of truth for the DEFAULT
 * agent / skill / tool / worker graph a provisioned Mantle ships with.
 *
 * Why this exists: the definitions and the LINKS between them were scattered
 * across the CLI seed scripts (each with its own imperative wiring + hardcoded
 * slugs), duplicated in onboarding + the sanity checks, and drifted silently
 * (broken links degrade with no error). This module centralises the structure
 * so a CI drift-test (manifest.test.ts) can fail the build on a dangling/typo'd
 * slug, and a live checker (integrity.ts) can diff the real DB rows against it.
 *
 * This is the AUTHORITATIVE source: it carries the link structure (slugs, roles,
 * tool/skill lists, delegation, assist surfaces, models, params), and the
 * instruction/prompt BODIES live in ./prompts.ts (referenced by slug). Onboarding
 * (fresh brains), the boot reconcile (existing brains on upgrade), the CLI
 * `pnpm seed:*` scripts, and the /settings/config checker all derive from here —
 * see ./CLAUDE.md for the change/propagation contract. The one deliberate overlay
 * is the persona PROMPT (generated from the persona bank in onboarding); the
 * persona's structure (model/params/memoryConfig/tool groups) lives here.
 *
 * Server-only (imports @mantle/tools). Consumers are all server-side: the
 * integrity + config checkers, onboarding, reconcile, the /debug/integrity and
 * /settings/config routes, and the validator test.
 *
 * NB: the named operator personas `telegram-default` (Saskia) and `apostle-paul`
 * are NOT manifest slugs — they're operator-owned and must never be seeded or
 * clobbered by anything derived from here.
 */

import {
  BUILTIN_TOOLS,
  PAGE_TOOL_SLUGS,
  APP_TOOL_SLUGS,
  TABLE_TOOL_SLUGS,
  CONTACT_AUTO_GRANT_SLUGS,
  JOURNAL_AUTO_GRANT_SLUGS,
  FORMULA_AUTO_GRANT_SLUGS,
  LOCATION_TOOL_SLUGS,
  PROFILE_TOOL_SLUGS,
  TOOLSMITH_TOOL_SLUGS,
  type HttpHandler,
} from '@mantle/tools';
import type { AiWorkerKind, AiWorkerParams, AgentMemoryConfig } from '@mantle/db';
import {
  DEFAULT_WORKER_SLUG,
  WORKER_MODEL_INHERIT,
  WORKER_SYSTEM_PROMPT,
  WORKER_TOOL_GROUP_SLUGS,
} from '@mantle/runs';
import { SKILL_INSTRUCTIONS, AGENT_PROMPTS } from './prompts';

// ── Types ────────────────────────────────────────────────────────────────────

export type ManifestSkill = {
  slug: string;
  name: string;
  description: string;
  /** The skill body rendered into the system prompt (verbatim, from ./prompts).
   *  Skills are PURE TEACHING — they carry no tools (the skills.tool_slugs column
   *  was dropped in P4; capability lives on agents + tool groups). */
  instructions: string;
};

export type ManifestToolGroup = {
  slug: string;
  name: string;
  description: string;
  /** Builtin tool slugs this group confers when granted to an agent. */
  toolSlugs: string[];
};

/** A templated HTTP API tool shipped with a provisioned Mantle and seeded at
 *  install — the SAME shape the Toolsmith agent authors at runtime, but baked
 *  into the manifest so common integrations (geocoding) work out of the box
 *  once the user adds the service key. The `handler` references the key via a
 *  `{{secret:service/label}}` vault ref, so no plaintext lives here. Seeded by
 *  applyManifest → seedManifestHttpTools (upsert by owner+slug). */
export type ManifestHttpTool = {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: HttpHandler;
  /** Pause for operator approval on each call. Read-only lookups: false. */
  requiresConfirm?: boolean;
};

export type ManifestAgent = {
  slug: string;
  name: string;
  description: string;
  role: 'responder' | 'custom' | 'worker';
  model: string;
  /** Env var that overrides `model` at seed time (e.g. 'PAGES_MODEL'). */
  envModelVar?: string;
  /** The onboarding persona ('assistant'); its prompt comes from the persona
   *  bank + the personality step, not this manifest. */
  isPersona?: boolean;
  /** Verbatim system prompt (from ./prompts) — specialists only; the persona
   *  carries none (its prompt is built from the persona bank). */
  systemPrompt?: string;
  /** Skills that SHOULD be attached to this agent. */
  skillSlugs: string[];
  /** Tool groups granted to this agent (named bundles). P6: the SOLE grant
   *  mechanism — the agent's effective tool set is exactly the union of these
   *  groups' tools (resolved + capped at runtime). Omitted ⇒ none.
   *  See docs/tools-and-skills.md. */
  toolGroupSlugs?: string[];
  /** Does the persona delegate TO this agent (invoke_agent allowlist)? */
  isDelegate?: boolean;
  /** Binds an in-surface "Assist" panel (/pages, /tables, /apps, /dev-tools) to this agent. */
  assistSurface?: 'pages' | 'tables' | 'apps' | 'dev-tools';
  params: { temperature: number; max_tokens?: number };
  /** Persisted verbatim to agents.memory_config. Carries the persona's context
   *  budgets (history/digest/fact limits, inject_journal) and a specialist's
   *  `max_iterations`; `delegate_to` lets a SPECIALIST delegate to another
   *  specialist (wireDelegation only wires the persona) — e.g. Appsmith →
   *  toolsmith for data-tool authoring. */
  memoryConfig?: AgentMemoryConfig;
  priority: number;
};

export type ManifestWorker = {
  kind: AiWorkerKind;
  name: string;
  /** Required for a healthy brain (the always-on indexing pipeline) vs optional
   *  (media — present only when provisioned). */
  required: boolean;
  /** Default route on the one-OpenRouter-key baseline. */
  provider: string;
  /** Canonical model on the default route. */
  model: string;
  /** Default-route params (e.g. extractor {extract_facts}, tts {voice,format}). */
  params?: AiWorkerParams;
  /** When the user has a key for this service, prefer the alt route instead of
   *  the default (voice upgrades to a dedicated xAI route). */
  altKeyService?: string;
  altProvider?: string;
  altModel?: string;
  altParams?: AiWorkerParams;
};

// ── Derived tool lists (match the seed scripts exactly) ──────────────────────

/** Page authoring set for the `pages` group: every page tool except the
 *  whole-page delete + live-overwrite (those ride the `page-admin` group) and
 *  the sharing toggles (which ride the standalone `page-share` group so the
 *  persona can share without holding the authoring toolkit). Block-level deletes
 *  (page_block_delete) stay — they're routine authoring. No overlap between the
 *  `pages`, `page-admin`, and `page-share` groups. */
const PAGE_AUTHORING_TOOL_SLUGS = PAGE_TOOL_SLUGS.filter(
  (s) => !['page_delete', 'page_update', 'page_share', 'page_unshare'].includes(s),
);
/** Table authoring set: every table tool except the whole-table delete (that
 *  rides `table-admin`). Row/column deletes stay — they're routine grid editing. */
const TABLE_AUTHORING_TOOL_SLUGS = TABLE_TOOL_SLUGS.filter((s) => s !== 'table_delete');
/** App authoring set for the `apps` group: every app tool except whole-app
 *  delete + publish (those ride the `app-admin` group, the Appsmith specialist
 *  only). No overlap between `apps` and `app-admin`. */
const APP_AUTHORING_TOOL_SLUGS = APP_TOOL_SLUGS.filter(
  (s) => !['app_delete', 'app_publish'].includes(s),
);

// ── Skills ───────────────────────────────────────────────────────────────────

export const MANIFEST_SKILLS: readonly ManifestSkill[] = [
  {
    slug: 'tool_grounding',
    name: 'Tool grounding',
    description: 'Search/verify before answering — never answer from memory alone.',
    instructions: SKILL_INSTRUCTIONS['tool_grounding']!,
  },
  {
    slug: 'specialist_routing',
    name: 'Specialist routing',
    description:
      'When to do page/table work directly vs delegate to a specialist, and how to pack a delegation prompt the child can act on.',
    instructions: SKILL_INSTRUCTIONS['specialist_routing']!,
  },
  {
    slug: 'voice_reply',
    name: 'Voice reply',
    description: 'How to write replies that will be spoken aloud (TTS).',
    instructions: SKILL_INSTRUCTIONS['voice_reply']!,
  },
  {
    slug: 'page_editing',
    name: 'Page editing',
    description:
      'Safe, scalable page authoring/editing; preserve words verbatim, prefer block tools.',
    instructions: SKILL_INSTRUCTIONS['page_editing']!,
  },
  {
    slug: 'chat_writing',
    name: 'Chat writing',
    description:
      'Standard Markdown for conversational replies — portable to web, mobile, and voice; no rich page dialect.',
    instructions: SKILL_INSTRUCTIONS['chat_writing']!,
  },
  {
    slug: 'rich_writing',
    name: 'Rich writing',
    description:
      'The rich Mantle dialect (callouts, asides, columns, KaTeX) for authoring PAGE documents — the Pages specialist.',
    instructions: SKILL_INSTRUCTIONS['rich_writing']!,
  },
  {
    slug: 'table_authoring',
    name: 'Table authoring',
    description: 'Build typed grids: columns, totals, formulas, views; edit by stable row/col id.',
    instructions: SKILL_INSTRUCTIONS['table_authoring']!,
  },
  {
    slug: 'app_authoring',
    name: 'App authoring',
    description:
      'The mini-app sandbox contract: allowed imports, the host bridge, sqlite, draft→build→publish.',
    instructions: SKILL_INSTRUCTIONS['app_authoring']!,
  },
  {
    slug: 'mantle-ops',
    name: 'Mantle ops',
    description: 'How Mantle works + the operating workflow (for the coder agent).',
    instructions: SKILL_INSTRUCTIONS['mantle-ops']!,
  },
  {
    slug: 'location_awareness',
    name: 'Location awareness',
    description:
      'Use the device location: resolve/cache addresses, find nearby places, reason about distance + timing.',
    instructions: SKILL_INSTRUCTIONS['location_awareness']!,
  },
  {
    slug: 'navigation',
    name: 'Navigation',
    description:
      'Find a route to a place, plot it on an inline map, and give a short driving/walking overview (not live turn-by-turn).',
    instructions: SKILL_INSTRUCTIONS['navigation']!,
  },
  {
    slug: 'integrations',
    name: 'Integrations',
    description:
      'Recognise "add/connect an API or service" requests and delegate them to the Toolsmith specialist to build, test, and grant.',
    instructions: SKILL_INSTRUCTIONS['integrations']!,
  },
];

/**
 * Every slug the manifest OWNS — the product-owned skill universe. The reconcile
 * uses it to converge an agent's skill links: a slug in here that an agent no
 * longer carries in the manifest is a RETIRED default (detach it), while a slug
 * NOT in here is operator-authored (never touched). See reconcile-util's
 * convergeManifestSkills + ./CLAUDE.md.
 */
export const MANIFEST_SKILL_SLUGS: ReadonlySet<string> = new Set(
  MANIFEST_SKILLS.map((s) => s.slug),
);

// ── Seeded HTTP API tools ────────────────────────────────────────────────────
//
// Shipped, ready-to-use HTTP tools (the install-seed counterpart to the
// Toolsmith authoring loop). They reference the key as a vault ref, so they sit
// dormant until the user adds the matching key under Settings → API keys
// (service 'mapbox', label 'default'); dispatch + the Toolsmith warning surface
// a clear "add it" message until then. Adding the next provider (LocationIQ) is
// a new entry here OR a live Toolsmith authoring run — no new architecture.
//
// Mapbox Geocoding v5: reverse turns coordinates into an address; the forward
// endpoint with a `proximity` bias answers "what <thing> is near me" (the
// coffee-place example). Both read-only ⇒ requiresConfirm omitted (false).

export const MAPBOX_KEY_REF = '{{secret:mapbox/default}}';

export const MANIFEST_HTTP_TOOLS: readonly ManifestHttpTool[] = [
  {
    slug: 'mapbox_reverse_geocode',
    name: 'Reverse geocode (Mapbox)',
    description:
      "Turn coordinates into a human-readable address via Mapbox. Input is `longitude` then `latitude` (decimal degrees). Returns Mapbox `features` (the first `place_name` is the best address). Use when you have coordinates (e.g. the device's Current location) and need the address — but check location_nearby first to reuse a saved place, and save the result with location_save afterwards. Requires a Mapbox key (Settings → API keys, service 'mapbox').",
    inputSchema: {
      type: 'object',
      properties: {
        longitude: { type: 'number', description: 'decimal degrees, −180..180' },
        latitude: { type: 'number', description: 'decimal degrees, −90..90' },
      },
      required: ['longitude', 'latitude'],
    },
    handler: {
      kind: 'http',
      method: 'GET',
      url: 'https://api.mapbox.com/geocoding/v5/mapbox.places/{longitude},{latitude}.json',
      query: { access_token: MAPBOX_KEY_REF, limit: '1' },
    },
  },
  {
    slug: 'mapbox_search',
    name: 'Search places (Mapbox)',
    description:
      "Find places matching a text query (e.g. 'coffee', 'pharmacy', 'Truth Coffee') near a point, via Mapbox forward geocoding with a proximity bias. Pass `query` plus the `longitude`/`latitude` to bias around (usually the device's Current location). Returns Mapbox `features` with each match's `place_name` and `center` ([lon, lat]) — feed those coordinates to location_distance to tell the user how far each is. Requires a Mapbox key (Settings → API keys, service 'mapbox').",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free-text place/category to search for' },
        longitude: { type: 'number', description: 'proximity-bias longitude' },
        latitude: { type: 'number', description: 'proximity-bias latitude' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'max results (default 5)' },
      },
      required: ['query', 'longitude', 'latitude'],
    },
    handler: {
      kind: 'http',
      method: 'GET',
      url: 'https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json',
      query: {
        access_token: MAPBOX_KEY_REF,
        proximity: '{longitude},{latitude}',
        limit: '{limit}',
      },
    },
  },
  {
    slug: 'mapbox_directions',
    name: 'Find a route (Mapbox)',
    description:
      "Find a route between two points via Mapbox Directions. Pass `profile` ('driving' or 'walking'), then the origin `from_longitude`/`from_latitude` and destination `to_longitude`/`to_latitude` (decimal degrees; usually the device's Current location → a place from mapbox_search). Returns `routes[0]` with `distance` (metres), `duration` (seconds), `geometry` (an ENCODED POLYLINE, precision 5 — feed it straight to route_map to plot the path), and `legs[].steps[].maneuver.instruction` (turn cues for a short human overview — NOT live turn-by-turn). Read-only; requires a Mapbox key (Settings → API keys, service 'mapbox').",
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['driving', 'walking'],
          description: "routing profile: 'driving' (default) or 'walking'",
        },
        from_longitude: { type: 'number', description: 'origin longitude, −180..180' },
        from_latitude: { type: 'number', description: 'origin latitude, −90..90' },
        to_longitude: { type: 'number', description: 'destination longitude, −180..180' },
        to_latitude: { type: 'number', description: 'destination latitude, −90..90' },
      },
      required: ['profile', 'from_longitude', 'from_latitude', 'to_longitude', 'to_latitude'],
    },
    handler: {
      kind: 'http',
      method: 'GET',
      // Numbers + the literal `,`/`;` separators stay intact through path
      // templating (numbers URL-encode to themselves); `profile` is a bare word.
      url: 'https://api.mapbox.com/directions/v5/mapbox/{profile}/{from_longitude},{from_latitude};{to_longitude},{to_latitude}',
      query: {
        access_token: MAPBOX_KEY_REF,
        // polyline (precision 5) so the geometry drops straight into the Static
        // Images `path` overlay; simplified keeps it under the static-URL cap.
        geometries: 'polyline',
        overview: 'simplified',
        steps: 'true',
        alternatives: 'false',
      },
    },
  },
];

/** Slugs of the seeded HTTP tools — known to the manifest the same way builtin
 *  slugs are, so a tool group may bundle them without tripping the drift test. */
export const MANIFEST_HTTP_TOOL_SLUGS: readonly string[] = MANIFEST_HTTP_TOOLS.map((t) => t.slug);

// ── Tool groups ──────────────────────────────────────────────────────────────
//
// Named, capability-only bundles (docs/tools-and-skills.md). P6: these are the
// SOLE grant mechanism — every MANIFEST_AGENTS entry is authored as a list of
// these slugs, and an agent's effective tool set is exactly the union of its
// groups' tools. The drift-test validates every slug here against
// KNOWN_TOOL_SLUGS and that every grantable builtin lives in ≥1 group.
//
// Destructive ops live in dedicated `*-admin` groups (`page-admin`,
// `table-admin`, `contacts-admin`, `journal-admin`) so they're granted only by
// deliberate group membership, never as a side effect of an authoring grant.
// The `pages`/`tables` groups carry the AUTHORING subsets only.

export const MANIFEST_TOOL_GROUPS: readonly ManifestToolGroup[] = [
  {
    slug: 'memory-core',
    name: 'Memory core',
    description: 'Search/read the brain — the baseline every responder needs.',
    toolSlugs: [
      'search_nodes',
      'search_chunks',
      'read_section',
      'tree_list',
      'node_read',
      'entity_search',
      'entity_neighbors',
      'graph_path',
      'entity_facts',
      'entity_mentions',
      'brain_capacity',
    ],
  },
  {
    slug: 'files',
    name: 'Files',
    description: 'Read, create, rename, and update files + folders (non-destructive — no delete).',
    toolSlugs: [
      'folder_list',
      'folder_get_by_path',
      'file_list',
      'file_get',
      'file_read',
      'file_create',
      'file_rename',
      'folder_rename',
      'folder_describe',
    ],
  },
  {
    slug: 'notes',
    name: 'Notes',
    description: 'Create/list/read notes + import a file or page as a note.',
    toolSlugs: ['note_create', 'note_list', 'note_get', 'note_from_file', 'note_from_page'],
  },
  {
    slug: 'events',
    name: 'Calendar',
    description: 'Calendar event CRUD.',
    toolSlugs: ['event_list', 'event_get', 'event_create', 'event_update', 'event_delete'],
  },
  {
    slug: 'tasks',
    name: 'Tasks',
    description: 'Task CRUD.',
    toolSlugs: ['task_list', 'task_get', 'task_create', 'task_update', 'task_delete'],
  },
  {
    slug: 'pages',
    name: 'Pages toolkit',
    description:
      'Author + edit rich pages, incl. block-level deletes (authoring subset; excludes whole-page delete/overwrite + the share toggles).',
    toolSlugs: [...PAGE_AUTHORING_TOOL_SLUGS],
  },
  {
    slug: 'page-admin',
    name: 'Page admin',
    description: 'Destructive + live-overwrite page ops — the Pages specialist only.',
    toolSlugs: ['page_delete', 'page_update'],
  },
  {
    slug: 'page-share',
    name: 'Page sharing',
    description:
      'Toggle a page public/private — lets the persona share without the authoring toolkit.',
    toolSlugs: ['page_share', 'page_unshare'],
  },
  {
    slug: 'sharing',
    name: 'Item sharing',
    description:
      'Mint/revoke a read-only public or team link for ANY shareable item (note, task, event, file, app, table, folder) — the type-agnostic counterpart of page-share. node_share is confirm-gated (publishes outward).',
    toolSlugs: ['node_share', 'node_unshare'],
  },
  {
    slug: 'apps',
    name: 'Apps toolkit',
    description:
      'Author + build mini apps: source files, esbuild, declared api_tools + sqlite schema (authoring subset; excludes whole-app delete + publish).',
    toolSlugs: [...APP_AUTHORING_TOOL_SLUGS],
  },
  {
    slug: 'app-admin',
    name: 'App admin',
    description: 'Destructive + go-live app ops (delete, publish) — the Appsmith specialist only.',
    toolSlugs: ['app_delete', 'app_publish'],
  },
  {
    slug: 'app-data',
    name: 'App data (read)',
    description:
      "Read a mini app's own SQLite database so the brain can answer from app-stored data. Read-only (the file is opened read-only — no query can mutate). Discovery + query only; no authoring.",
    toolSlugs: ['app_db_list', 'app_db_query'],
  },
  {
    slug: 'tables',
    name: 'Tables toolkit',
    description:
      'Build + edit typed grids, incl. row/column deletes (authoring subset; excludes the whole-table delete).',
    toolSlugs: [...TABLE_AUTHORING_TOOL_SLUGS],
  },
  {
    slug: 'table-admin',
    name: 'Table admin',
    description: 'Destructive table delete — deliberate-only, not granted by default.',
    toolSlugs: ['table_delete'],
  },
  {
    slug: 'tables-import',
    name: 'Tables import',
    description:
      'Import a spreadsheet (.xlsx/.xls/.csv) into typed Table(s) on request — the responder-facing slice of Tables, so an attached register can be tabled directly without the full grid-authoring kit (which stays with the Ledger specialist). Spreadsheets are already auto-imported on ingest; this covers an explicit "(re)import this as a table" ask.',
    toolSlugs: ['table_from_file'],
  },
  {
    slug: 'tables-read',
    name: 'Tables (read)',
    description:
      "Read-only structured access to typed grids — list/schema/query/SQL/aggregate — so a responder can ANSWER from tables directly (the tool_grounding skill's table_sql ladder) instead of delegating a lookup that averages minutes. No writes; same read surface the team responder holds.",
    toolSlugs: [
      'table_list',
      'table_get',
      'table_schema',
      'table_query',
      'table_sql',
      'table_rows_list',
      'table_row_get',
      'table_aggregate',
    ],
  },
  {
    slug: 'tables-rows',
    name: 'Tables row writes',
    description:
      'Single-row inserts + updates ("log this expense") — the light write slice of the grid. Schema/column/tab work, imports, reorders, and multi-row transforms stay with the Ledger specialist; row deletes stay deliberate-only (table-admin).',
    toolSlugs: ['table_row_add', 'table_row_update'],
  },
  {
    slug: 'pages-draft',
    name: 'Pages light edits',
    description:
      'The responder-facing slice of Pages: create a page, write/replace its DRAFT, and read/edit single blocks — enough for "save this as a page" and one-block fixes without the full authoring kit (multi-block surgery, imports, splits, moves stay with the Pages specialist). Every body write lands in the draft; the operator commits.',
    toolSlugs: [
      'page_create',
      'page_update_draft',
      'page_list',
      'page_get',
      'page_blocks_list',
      'page_block_get',
      'page_block_update',
      'page_block_insert_after',
    ],
  },
  {
    slug: 'export',
    name: 'Document export',
    description:
      'Render a page/note to Word (.docx) or a table to Excel (.xlsx) and save it under /files/exports. Non-destructive.',
    toolSlugs: ['export_node'],
  },
  {
    slug: 'curation',
    name: 'Content curation',
    description:
      'Mark content superseded/outdated so retrieval prefers the living copy — the content-currency layer. Reversible down-weights, never deletes.',
    toolSlugs: ['content_supersede'],
  },
  {
    slug: 'contacts',
    name: 'Contacts',
    description:
      'The people/org index — also the email allowlist (docs/contacts.md). No delete (escape hatch).',
    // No-delete subset (mirrors pages/tables, decision 3); contact_delete rides
    // the `contacts-admin` group. Matches CORE_AUTO_GRANT exactly, so an
    // auto-granted conversational agent qualifies for the whole group.
    toolSlugs: [...CONTACT_AUTO_GRANT_SLUGS],
  },
  {
    slug: 'contacts-admin',
    name: 'Contacts admin',
    description: 'Delete a contact — deliberate-only; not on the persona.',
    toolSlugs: ['contact_delete'],
  },
  {
    slug: 'journal',
    name: 'Journal',
    description:
      "First-person self-knowledge — the identity context's source. No delete (escape hatch).",
    // No-delete subset (decision 3 pattern); journal_delete rides the
    // `journal-admin` group. Matches CORE_AUTO_GRANT exactly so auto-granted
    // agents qualify for the group.
    toolSlugs: [...JOURNAL_AUTO_GRANT_SLUGS],
  },
  {
    slug: 'journal-admin',
    name: 'Journal admin',
    description: 'Delete a journal entry — deliberate-only; not on the persona.',
    toolSlugs: ['journal_delete'],
  },
  {
    slug: 'formulas',
    name: 'Formulas',
    description:
      'Author, read and evaluate calculation models taken from standards. No delete (escape hatch).',
    // No-delete subset (decision 3 pattern); formula_delete rides the
    // `formulas-admin` group.
    toolSlugs: [...FORMULA_AUTO_GRANT_SLUGS],
  },
  {
    slug: 'formulas-admin',
    name: 'Formulas admin',
    description: 'Delete a formula — deliberate-only; not on the persona.',
    toolSlugs: ['formula_delete'],
  },
  {
    slug: 'recall',
    name: 'Recall',
    description: 'Replay a past conversation window (the responder-facing half of recall).',
    // Just the replay tool — the persona holds this so it can quote past
    // conversations. Finding the window (find_window) is Remy's specialist job
    // and rides the separate `recall-search` group (it's denied to the persona).
    toolSlugs: ['recall_window'],
  },
  {
    slug: 'recall-search',
    name: 'Recall search',
    description: 'Locate the right past-conversation window to replay (Remy only).',
    toolSlugs: ['find_window'],
  },
  {
    slug: 'research',
    name: 'Web research',
    description:
      'Live web access — search (Perplexity Sonar via OpenRouter, standard + deep tiers) plus web_fetch to read a page or documentation by URL.',
    toolSlugs: ['web_search', 'web_search_pro', 'web_fetch'],
  },
  {
    slug: 'web-read',
    name: 'Web page reader',
    description:
      'Open a web page by URL and read its readable content (web_fetch only — no search). The Reader specialist; lets the responder pull a specific page in as context without the search tiers.',
    toolSlugs: ['web_fetch'],
  },
  {
    slug: 'email',
    name: 'Email',
    description: 'Send + read email (gated by the contacts allowlist).',
    toolSlugs: ['email_send', 'email_page', 'email_list', 'email_get'],
  },
  {
    slug: 'persona',
    name: 'Persona',
    description: 'Record durable style/relationship calibrations.',
    toolSlugs: ['update_persona'],
  },
  {
    slug: 'secrets',
    name: 'Secrets',
    description: 'Store a secret/credential the user shares in conversation.',
    toolSlugs: ['secret_create'],
  },
  {
    slug: 'ingest',
    name: 'Ingest',
    description: 'Kick off content extraction on an uploaded/referenced source.',
    toolSlugs: ['process_extraction'],
  },
  {
    slug: 'media-workers',
    name: 'Media workers',
    description: 'Delegate to TTS / vision / summarizer / image workers.',
    toolSlugs: ['synthesize_speech', 'extract_from_image', 'summarize_text', 'generate_image'],
  },
  {
    slug: 'delegation',
    name: 'Delegation',
    description: 'Invoke specialist sub-agents.',
    toolSlugs: ['invoke_agent'],
  },
  {
    slug: 'messaging',
    name: 'Messaging',
    description: 'Send Telegram messages from the responder.',
    toolSlugs: ['telegram_send'],
  },
  {
    slug: 'tool-results',
    name: 'Tool results',
    description: 'Dereference spilled (oversized) tool results — the loop offers this anyway.',
    toolSlugs: ['read_result'],
  },
  {
    slug: 'terminal',
    name: 'Terminal',
    description: 'Unrestricted shell — coder/ops only.',
    toolSlugs: ['run_terminal'],
  },
  {
    slug: 'brain-health',
    name: 'Brain health',
    description:
      'Self-monitoring: corpus capacity vs the split policy (brain_capacity) and the scheduled retrieval-quality eval (recall_eval). Grant to the agent that runs the brain-health heartbeat.',
    toolSlugs: ['brain_capacity', 'recall_eval'],
  },
  {
    slug: 'federation',
    name: 'Federation',
    description: "Query other people's Mantles for data they've shared (docs/federation.md).",
    toolSlugs: ['peer_list', 'peer_query', 'peer_search_chunks', 'peer_node_get'],
  },
  {
    slug: 'location',
    name: 'Location & places',
    description:
      'Geo awareness: reverse-geocode coordinates to an address (Mapbox), find places nearby, reuse saved places, compute distances, find routes and plot them on an inline map. Pairs with the location_awareness + navigation skills.',
    // Local builtins (save/nearby/distance + route_map) + the seeded Mapbox HTTP
    // tools (reverse-geocode/search/directions). All stay dormant until the user
    // adds a 'mapbox' key.
    toolSlugs: [...LOCATION_TOOL_SLUGS, ...MANIFEST_HTTP_TOOL_SLUGS],
  },
  {
    slug: 'profile',
    name: 'Profile preferences',
    description:
      "Adjust the owner's time-aware profile settings in-conversation — currently the timezone, so a travelling user's clock, scheduling, and reminders stay correct without visiting Settings.",
    toolSlugs: [...PROFILE_TOOL_SLUGS],
  },
  {
    slug: 'toolsmith',
    name: 'Toolsmith kit',
    description:
      'Author/test/group/grant templated HTTP API tools + web_fetch for reading API docs — the Toolsmith specialist (and trusted operators) only: it can mint new capabilities and grant them to agents.',
    toolSlugs: [...TOOLSMITH_TOOL_SLUGS],
  },
  {
    slug: 'team-read',
    name: 'Team Chat (member-facing)',
    description:
      "The team responder's entire tool surface: read-only access across the brain (search, files, notes, pages, tables, events, tasks, contacts, app data) plus its ONE write action — filing a team change request into the specialist review queue. email_*/journal_* are ALSO granted here but gated at runtime by the owner's `teamPrivateReads` switch (default OFF — see run-team-turn.ts / TEAM_PRIVATE_READ_SLUGS), so the owner's private corpus is off-limits unless explicitly opted in. Deliberately excludes export_node (bulk exfiltration ease), recall_window (replays the OWNER's private conversations), all other writes, delegation, terminal, http, and send tools. Non-private reads are brain-wide BY DESIGN (brain = the trust boundary).",
    toolSlugs: [
      // memory-core reads
      'search_nodes',
      'search_chunks',
      'read_section',
      'tree_list',
      'node_read',
      'entity_search',
      'entity_neighbors',
      'graph_path',
      'entity_facts',
      'entity_mentions',
      // file/folder reads (no create/rename)
      'folder_list',
      'folder_get_by_path',
      'file_list',
      'file_get',
      'file_read',
      'folder_describe',
      // content-surface reads
      'note_list',
      'note_get',
      'page_list',
      'page_get',
      'page_blocks_list',
      'page_block_get',
      'table_list',
      'table_get',
      'table_schema',
      'table_query',
      'table_sql',
      'table_rows_list',
      'table_row_get',
      'table_aggregate',
      'event_list',
      'event_get',
      'task_list',
      'task_get',
      'contact_find',
      'contact_list',
      'contact_get',
      'journal_list',
      'journal_get',
      'email_list',
      'email_get',
      'app_db_list',
      'app_db_query',
      // utilities the read loop needs
      'summarize_text',
      'read_result',
      // the single write path: provenance-stamped request task
      'team_request_create',
    ],
  },
  {
    slug: 'team-admin',
    name: 'Team Chat admin',
    description:
      "Owner-side view over the Team Chat surface: list members + activity, read any member's thread, read the access log. Granted to the persona so the brain can answer 'what has <member> asked about?' — NEVER to the team responder itself.",
    toolSlugs: ['team_chat_list', 'team_chat_read', 'team_access_list'],
  },
  {
    slug: 'runs',
    name: 'Runner queues',
    description:
      'Plan, inspect, extend, and cancel durable background runs (docs/runs.md). ' +
      'Responder-only — never granted to workers or specialists (items must not ' +
      'create runs). Creation is additionally gated by MANTLE_RUNS; not attached ' +
      'to the persona by default while the feature dogfoods.',
    toolSlugs: ['run_plan', 'run_append', 'run_state', 'run_cancel', 'run_audit'],
  },
];

// ── Agents ───────────────────────────────────────────────────────────────────

export const MANIFEST_AGENTS: readonly ManifestAgent[] = [
  {
    slug: 'assistant',
    name: 'Assistant',
    description: 'The generalist persona — serves web /assistant and Telegram.',
    role: 'responder',
    model: 'anthropic/claude-sonnet-5',
    isPersona: true,
    // P6: grants are pure tool groups — the generalist's effective set is the
    // union of these bundles. Page/table work is HYBRID (2026-07-18 delegation
    // review, page a7f3255d on dev): the persona holds the LIGHT slices
    // directly — `tables-read` (answer from grids; tool_grounding's table_sql
    // ladder assumed this all along), `tables-rows` (single-row writes), and
    // `pages-draft` (create / draft-write / single-block fixes) — while HEAVY
    // transforms (multi-block restyles, schema/column work, imports) stay
    // delegated to the Pages / Ledger specialists (no `pages`/`tables`/
    // `page-admin`; `page-share` kept so it can publish). The specialist_routing
    // skill carries the light-vs-heavy policy. NOT granted: the `*-admin`
    // deletes (deliberate-only), `recall-search`/`research`/`terminal`
    // (specialist — research/reader stay delegated ON PURPOSE: web content is
    // untrusted input, and the no-write-tools child is the injection firewall).
    // `federation` IS granted: peer reads are scoped by the answering side's
    // grants, and without the group the persona can't reach paired brains at
    // all (it invents workarounds instead). Versus the pre-P6 set this drops
    // `contact_delete` + `journal_delete` (now deliberate-only) — the one
    // intentional removal.
    toolGroupSlugs: [
      'memory-core',
      'files',
      'notes',
      'events',
      'tasks',
      'contacts',
      'journal',
      'recall',
      'email',
      'persona',
      'media-workers',
      'delegation',
      'messaging',
      'secrets',
      'ingest',
      'tool-results',
      'page-share',
      'sharing',
      'location',
      'profile',
      'export',
      'curation',
      'tables-import',
      'tables-read',
      'tables-rows',
      'formulas',
      'pages-draft',
      'app-data',
      'team-admin',
      'federation',
    ],
    skillSlugs: [
      'tool_grounding',
      'voice_reply',
      'chat_writing',
      'location_awareness',
      'navigation',
      'integrations',
      'specialist_routing',
    ],
    params: { temperature: 0.7, max_tokens: 16000 },
    // Context budgets for the generalist responder. Onboarding seeds these
    // verbatim; the persona's PROMPT stays an overlay (persona bank + the
    // personality step), so it is not carried here. delegate_to is wired
    // separately by wireDelegation (starts empty).
    memoryConfig: {
      history_limit: 20,
      digest_limit: 3,
      fact_limit: 10,
      content_hit_limit: 5,
      // Section passages to auto-inject. Budget = chunk_limit × chunk size;
      // with the larger ~2.75k-char chunks, 8 ≈ 22k chars of real coverage.
      // Kept in sync with the runtime CHUNK_LIMIT_DEFAULT.
      chunk_limit: 8,
      inject_journal: true,
      delegate_to: [],
      // The generalist isn't only a read-then-reply chat agent: real tasks are
      // "read N source docs → compile → author a page/note", which needs more
      // than the runtime default of 6 tool rounds. At 6 the loop force_finals
      // mid-read and the authoring step never runs (the task looks "never
      // finished"). 25 gives headroom for heavy gather-then-write turns; the
      // runtime still hard-caps at 30. Specialists set their own (Pages 20,
      // Tables/Toolsmith/Appsmith 30).
      max_iterations: 25,
    },
    priority: 100,
  },
  {
    slug: 'pages',
    name: 'Pages',
    description: 'Document authoring + editing specialist; backs the /pages Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'PAGES_MODEL',
    systemPrompt: AGENT_PROMPTS['pages']!,
    // P6: full page capability via groups — `pages` (authoring) + `page-admin`
    // (delete/overwrite) + `page-share` reassemble the complete PAGE_TOOL_SLUGS
    // set; `files`/`memory-core` cover source reads + cross-context lookups.
    // (Approach A: this coarsens to full `files`/`memory-core`, a benign gain.)
    toolGroupSlugs: [
      'pages',
      'page-admin',
      'page-share',
      'files',
      'memory-core',
      'export',
      'curation',
    ],
    skillSlugs: ['rich_writing', 'page_editing'],
    isDelegate: true,
    assistSurface: 'pages',
    params: { temperature: 0.3, max_tokens: 32000 },
    // Real page work is tool-call heavy: a large restructure is read + N block
    // updates + M deletes, and the flat defaults (40/turn, 15/tool) sever it
    // mid-edit (SOP-restructure incident, 2026-07-06 — a 205-block restructure
    // died at the delete phase twice). 100/40 covers a ~30-block edit with
    // reads included; the runtime hard-caps at 200/100.
    memoryConfig: { max_iterations: 20, max_tool_calls: 100, max_calls_per_tool: 40 },
    priority: 100,
  },
  {
    slug: 'tables',
    name: 'Ledger',
    description: 'Typed-grid + data specialist; backs the /tables Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'TABLES_MODEL',
    systemPrompt: AGENT_PROMPTS['tables']!,
    // P6: `tables` is the authoring subset (no `table-admin`/table_delete);
    // `files`/`memory-core` cover source reads + cross-context lookups. Page
    // sharing is Pages' job, not Ledger's — no `page-share` here.
    toolGroupSlugs: ['tables', 'files', 'memory-core', 'export'],
    skillSlugs: ['table_authoring'],
    isDelegate: true,
    assistSurface: 'tables',
    params: { temperature: 0.3, max_tokens: 16000 },
    memoryConfig: { max_iterations: 30 },
    priority: 100,
  },
  {
    slug: 'remy',
    name: 'Remy',
    description: 'Memory-recall agent — replays past conversations from the archive.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'REMY_MODEL',
    systemPrompt: AGENT_PROMPTS['remy']!,
    // P6: `recall` (replay) + `recall-search` (find_window, Remy's specialty) +
    // `memory-core` for the node lookups it cites.
    toolGroupSlugs: ['recall', 'recall-search', 'memory-core'],
    skillSlugs: [],
    isDelegate: true,
    params: { temperature: 0.2 },
    priority: 100,
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Live-web research agent (Perplexity Sonar via OpenRouter).',
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'RESEARCHER_MODEL',
    systemPrompt: AGENT_PROMPTS['researcher']!,
    // P6: `research` (web_search) + `memory-core` for the node lookups it cites.
    toolGroupSlugs: ['research', 'memory-core'],
    skillSlugs: [],
    isDelegate: true,
    params: { temperature: 0.3 },
    priority: 100,
  },
  {
    slug: 'reader',
    name: 'Reader',
    description:
      'Web page reader — opens a URL and reads its content back as context for the responder.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'READER_MODEL',
    systemPrompt: AGENT_PROMPTS['reader']!,
    // Just `web-read` (web_fetch) — a focused page reader, deliberately without
    // the search tiers (that's the Researcher) or memory-core (it works from the
    // URL it's handed, like the Toolsmith works from docs).
    toolGroupSlugs: ['web-read'],
    skillSlugs: [],
    isDelegate: true,
    params: { temperature: 0.3 },
    priority: 100,
  },
  {
    slug: 'toolsmith',
    name: 'Toolsmith',
    description:
      'API integration specialist — reads service docs, authors + tests agent-callable HTTP tools; backs the API Console Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'TOOLSMITH_MODEL',
    systemPrompt: AGENT_PROMPTS['toolsmith']!,
    // `toolsmith` (the api_tool_*/group/grant/web_fetch kit) + `research` so it
    // can locate a service's docs when given only a name. Deliberately NOT
    // memory-core — it works from docs + the registry, not the user's brain.
    toolGroupSlugs: ['toolsmith', 'research'],
    skillSlugs: [],
    isDelegate: true,
    assistSurface: 'dev-tools',
    // Doc-reading + author + test loops chew iterations; match Ledger's budget.
    params: { temperature: 0.2, max_tokens: 16000 },
    memoryConfig: { max_iterations: 30 },
    priority: 100,
  },
  {
    slug: 'coder',
    name: 'Brian the Coder',
    description: 'Code + ops specialist (holds the unrestricted terminal).',
    role: 'custom',
    model: 'anthropic/claude-opus-4.7',
    envModelVar: 'CODER_MODEL',
    systemPrompt: AGENT_PROMPTS['coder']!,
    // P6: `terminal` (unrestricted shell) + `files` + `memory-core`.
    toolGroupSlugs: ['terminal', 'files', 'memory-core'],
    skillSlugs: ['mantle-ops'],
    isDelegate: true,
    params: { temperature: 0.2 },
    priority: 100,
  },
  {
    slug: 'appsmith',
    name: 'Appsmith',
    description:
      "Mini-app builder — writes real TSX against the app's shadcn UI + theme, bundles with esbuild, renders in a sandbox; backs the /apps Assist panel.",
    role: 'custom',
    model: 'anthropic/claude-opus-4.8',
    envModelVar: 'APPSMITH_MODEL',
    systemPrompt: AGENT_PROMPTS['appsmith']!,
    // `apps` (authoring) + `app-admin` (delete/publish) reassemble the full
    // APP_TOOL_SLUGS set; `files`/`memory-core` for source reads + lookups;
    // `delegation` so it can hand data-tool work to the toolsmith; `research`
    // (web_search + web_fetch) so it can look up library/API docs while coding.
    toolGroupSlugs: ['apps', 'app-admin', 'files', 'memory-core', 'delegation', 'research'],
    skillSlugs: ['app_authoring'],
    isDelegate: true,
    assistSurface: 'apps',
    params: { temperature: 0.2, max_tokens: 32000 },
    // Codegen → build → read-errors → fix loops chew iterations. delegate_to
    // toolsmith: Appsmith doesn't author HTTP tools, it delegates that. This
    // edge works even when Appsmith itself runs as a delegate (responder →
    // appsmith → toolsmith): toolsmith is a TERMINAL specialist, which is the
    // one depth-3 shape the invoke_agent guards allow (MAX_TERMINAL_EDGE_DEPTH).
    memoryConfig: { max_iterations: 30, delegate_to: ['toolsmith'] },
    priority: 100,
  },
  {
    slug: 'team-responder',
    name: 'Team Responder',
    description:
      "Permission-limited responder for the external Team Chat surface (/team) — serves team-member contacts, read-only plus filing change requests. Never appears in the owner's Conversations inbox and is never a delegate.",
    role: 'custom',
    model: 'anthropic/claude-sonnet-5',
    envModelVar: 'TEAM_RESPONDER_MODEL',
    systemPrompt: AGENT_PROMPTS['team-responder']!,
    // `team-read` is its ENTIRE surface (see the group's description for the
    // exclusion rationale). Not a delegate, no assist surface — it is resolved
    // explicitly by the team turn pipeline and nothing else.
    toolGroupSlugs: ['team-read'],
    skillSlugs: ['tool_grounding', 'chat_writing'],
    params: { temperature: 0.4, max_tokens: 16000 },
    // No owner-personal context: inject_journal OFF (the identity context is
    // the OWNER's self-knowledge), no digests (those summarize the owner's own
    // conversations). History comes from the member's team thread, loaded by
    // the team context loader — history_limit budgets that window.
    memoryConfig: {
      history_limit: 20,
      digest_limit: 0,
      fact_limit: 10,
      content_hit_limit: 5,
      chunk_limit: 8,
      inject_journal: false,
      delegate_to: [],
      max_iterations: 15,
    },
    priority: 100,
  },
  {
    // The default runner-queue WORKER agent (docs/runs.md "Workers + audits").
    // A TEMPLATE, not a resident process: each `worker_invoke` run item spawns a
    // fresh agent turn from this row (model, kit, instructions). It is never
    // chattable, never a delegate, and holds no assist surface — the run engine
    // instantiates it, nothing else. Its definition constants live in
    // @mantle/runs (packages/runs/src/worker.ts) so the template stays
    // single-sourced across the manifest and the engine's lazy
    // `ensureWorkerAgent` fallback (which finds this seeded row on brains that
    // have reconciled). role 'worker'; model = the 'inherit' sentinel (run on
    // the responder's model/provider/key at execution time — the default,
    // structural-not-cost-arbitrage win); tool GROUPS ('memory-core') carry the
    // propose-don't-mutate read/search kit (no write groups, no run tools, no
    // delegation — also enforced by executing at delegation depth 2).
    slug: DEFAULT_WORKER_SLUG,
    name: 'Worker agent',
    description:
      'Default runner-queue worker: executes delegated run steps and returns evidence-bearing proposals. Duplicate and set a cheaper model to opt into cost arbitrage.',
    role: 'worker',
    model: WORKER_MODEL_INHERIT,
    systemPrompt: WORKER_SYSTEM_PROMPT,
    toolGroupSlugs: [...WORKER_TOOL_GROUP_SLUGS],
    skillSlugs: [],
    // Focused evidence-gathering: low temperature. (Worker turns read
    // agents.params for the LLM call; memoryConfig is not consulted for a
    // worker turn, so it is left at the default {}.)
    params: { temperature: 0.3 },
    priority: 100,
  },
];

// ── Workers ──────────────────────────────────────────────────────────────────

// One OpenRouter key powers everything; gemini-3.1-flash-lite is the cheap
// multimodal workhorse behind the indexing pipeline + document/vision. Voice
// (tts/stt) runs on the OpenRouter route by default and UPGRADES to a dedicated
// xAI route when the user has an xAI key (the proven grok path). These models +
// params are the single source — onboarding and reconcile both seed from here
// (see resolveWorkerRoute + seedManifestWorkers). The tts `voice` is the female
// default ('ara' = voiceForGender('female')); the personality step retunes it.
export const MANIFEST_WORKERS: readonly ManifestWorker[] = [
  {
    kind: 'extractor',
    name: 'Extractor',
    required: true,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
    params: { extract_facts: true },
  },
  {
    kind: 'summarizer',
    name: 'Summarizer',
    required: true,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
  },
  {
    kind: 'reflector',
    name: 'Reflector',
    required: true,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
  },
  {
    kind: 'document',
    name: 'Document reader',
    required: true,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
  },
  {
    kind: 'vision',
    name: 'Read images',
    required: false,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
  },
  {
    kind: 'image_gen',
    name: 'Image generation',
    required: false,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-image-preview',
  },
  {
    kind: 'tts',
    name: 'Assistant voice',
    required: false,
    provider: 'openrouter',
    model: 'x-ai/grok-voice-tts-1.0',
    params: { voice: 'ara', format: 'mp3' },
    altKeyService: 'xai',
    altProvider: 'xai',
    altModel: 'grok-voice-latest',
    altParams: { voice: 'ara', format: 'mp3' },
  },
  {
    kind: 'stt',
    name: 'Transcribe voice',
    required: false,
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini-transcribe',
    params: { language: 'en' },
    altKeyService: 'xai',
    altProvider: 'xai',
    altModel: 'grok-stt',
    altParams: { language: 'en' },
  },
  // Web search tiers (Perplexity Sonar via OpenRouter). The researcher's
  // `web_search` uses the cheap/fast tier; `web_search_pro` the stronger one.
  {
    kind: 'search',
    name: 'Web search',
    required: false,
    provider: 'openrouter',
    model: 'perplexity/sonar',
  },
  {
    kind: 'search_advanced',
    name: 'Deep web search',
    required: false,
    provider: 'openrouter',
    model: 'perplexity/sonar-pro',
  },
  // Narrator — restyles the live turn "thought trail" status into the assistant's
  // voice. A BASELINE worker: required so it auto-seeds on fresh onboarding AND
  // reaches existing brains on upgrade (the reconcile's requiredOnly pass). Same
  // cheap/fast workhorse model as the indexing workers. It isn't part of the
  // indexing pipeline, and if it's ever missing the runtime falls back to the
  // summarizer — so narration degrades gracefully. Verbosity (phrase → sentence →
  // paragraph) is tuned via the worker's system prompt + max_tokens in Settings →
  // AI workers, not here.
  {
    kind: 'narrator',
    name: 'Narrator',
    required: true,
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
  },
];

// ── Derived selectors (single computation; kills the duplication) ────────────

/** The persona agent's manifest entry — the template onboarding builds the
 *  generalist from (model/params/memoryConfig/tool groups). Its PROMPT is the
 *  one overlay: generated from the persona bank + the personality step. */
export const PERSONA_MANIFEST = MANIFEST_AGENTS.find((a) => a.isPersona)!;

/** Slug of the persona agent (the delegation entry point). */
export const PERSONA_SLUG = PERSONA_MANIFEST.slug;

/** The persona's default tool grant (P6: pure tool GROUPS — the generalist's
 *  whole capability). Onboarding seeds a fresh persona with exactly these. */
export const PERSONA_TOOL_GROUP_SLUGS: readonly string[] = PERSONA_MANIFEST.toolGroupSlugs ?? [];

/** The agents the persona delegates to (memory_config.delegate_to). */
export const DELEGATE_SLUGS: readonly string[] = MANIFEST_AGENTS.filter((a) => a.isDelegate).map(
  (a) => a.slug,
);

/** surface → default specialist slug, for the in-surface Assist panels. */
export const ASSIST_SURFACE_DEFAULTS: Record<'pages' | 'tables' | 'apps' | 'dev-tools', string> =
  Object.fromEntries(
    MANIFEST_AGENTS.filter((a) => a.assistSurface).map((a) => [a.assistSurface!, a.slug]),
  ) as Record<'pages' | 'tables' | 'apps' | 'dev-tools', string>;

/**
 * Tool slugs that exist as real handlers but are registered OUTSIDE the static
 * BUILTIN_TOOLS array (heartbeat controls register only in the agent process via
 * @mantle/heartbeats). The validator treats these as known so a future manifest
 * entry referencing them doesn't false-fail; none are referenced today.
 */
export const KNOWN_EXTERNAL_TOOL_SLUGS: readonly string[] = [
  'heartbeat_fire',
  'heartbeat_complete',
  'heartbeat_snooze',
  'heartbeat_list',
  'heartbeat_update_state',
];

/** The set of tool slugs the manifest is allowed to reference: builtins, the
 *  runtime-only externals, and the seeded HTTP tools (so a group may bundle
 *  mapbox_* without false-failing the drift test). */
export const KNOWN_TOOL_SLUGS: ReadonlySet<string> = new Set<string>([
  ...BUILTIN_TOOLS.map((t) => t.slug),
  ...KNOWN_EXTERNAL_TOOL_SLUGS,
  ...MANIFEST_HTTP_TOOL_SLUGS,
]);

/** Slugs of every manifest tool group (the set an agent may reference). */
export const KNOWN_TOOL_GROUP_SLUGS: ReadonlySet<string> = new Set<string>(
  MANIFEST_TOOL_GROUPS.map((g) => g.slug),
);

export const SYSTEM_MANIFEST = {
  skills: MANIFEST_SKILLS,
  toolGroups: MANIFEST_TOOL_GROUPS,
  httpTools: MANIFEST_HTTP_TOOLS,
  agents: MANIFEST_AGENTS,
  workers: MANIFEST_WORKERS,
} as const;
