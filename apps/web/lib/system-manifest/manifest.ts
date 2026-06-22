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
 * Phase 1 (current): the manifest is DESCRIPTIVE — it carries the link
 * structure (slugs, roles, tool/skill lists, delegation, assist surfaces,
 * models, params). The big instruction/prompt BODIES still live in the seed
 * scripts; Phase 2 moves them here and makes the seeders drive off the manifest.
 *
 * Server-only (imports @mantle/tools). Consumers are all server-side: the
 * integrity checker, onboarding's sanity step, the /debug/integrity route, and
 * the validator test.
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
  LIFELOG_AUTO_GRANT_SLUGS,
  LOCATION_TOOL_SLUGS,
  PROFILE_TOOL_SLUGS,
  TOOLSMITH_TOOL_SLUGS,
  type HttpHandler,
} from '@mantle/tools';
import type { AiWorkerKind } from '@mantle/db';
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
  role: 'responder' | 'custom';
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
  /** Persisted verbatim to agents.memory_config. `delegate_to` lets a SPECIALIST
   *  delegate to another specialist (wireDelegation only wires the persona) —
   *  e.g. Appsmith → toolsmith for data-tool authoring. */
  memoryConfig?: { max_iterations?: number; delegate_to?: string[] };
  priority: number;
};

export type ManifestWorker = {
  kind: AiWorkerKind;
  name: string;
  /** Canonical model on the one-OpenRouter-key baseline (voice may run on xAI). */
  model: string;
  /** Required for a healthy brain (the always-on indexing pipeline) vs optional
   *  (media — present only when provisioned). */
  required: boolean;
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
    slug: 'voice_reply',
    name: 'Voice reply',
    description: 'How to write replies that will be spoken aloud (TTS).',
    instructions: SKILL_INSTRUCTIONS['voice_reply']!,
  },
  {
    slug: 'page_editing',
    name: 'Page editing',
    description: 'Safe, scalable page authoring/editing; preserve words verbatim, prefer block tools.',
    instructions: SKILL_INSTRUCTIONS['page_editing']!,
  },
  {
    slug: 'rich_writing',
    name: 'Rich writing',
    description: 'The rich Mantle dialect: callouts, asides, columns, tables, task lists, KaTeX.',
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
    description: 'The mini-app sandbox contract: allowed imports, the host bridge, sqlite, draft→build→publish.',
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
    description: 'Use the device location: resolve/cache addresses, find nearby places, reason about distance + timing.',
    instructions: SKILL_INSTRUCTIONS['location_awareness']!,
  },
  {
    slug: 'navigation',
    name: 'Navigation',
    description: 'Find a route to a place, plot it on an inline map, and give a short driving/walking overview (not live turn-by-turn).',
    instructions: SKILL_INSTRUCTIONS['navigation']!,
  },
  {
    slug: 'integrations',
    name: 'Integrations',
    description: 'Recognise "add/connect an API or service" requests and delegate them to the Toolsmith specialist to build, test, and grant.',
    instructions: SKILL_INSTRUCTIONS['integrations']!,
  },
];

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
// `table-admin`, `contacts-admin`, `lifelog-admin`) so they're granted only by
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
      'tree_list',
      'node_read',
      'entity_search',
      'entity_neighbors',
      'graph_path',
      'entity_facts',
      'entity_mentions',
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
    description: 'Create/list/read notes.',
    toolSlugs: ['note_create', 'note_list', 'note_get'],
  },
  {
    slug: 'events',
    name: 'Calendar',
    description: 'Calendar event CRUD.',
    toolSlugs: ['event_list', 'event_get', 'event_create', 'event_update', 'event_delete'],
  },
  {
    slug: 'todos',
    name: 'To-dos',
    description: 'To-do CRUD.',
    toolSlugs: ['todo_list', 'todo_get', 'todo_create', 'todo_update', 'todo_delete'],
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
    description: 'Toggle a page public/private — lets the persona share without the authoring toolkit.',
    toolSlugs: ['page_share', 'page_unshare'],
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
    slug: 'contacts',
    name: 'Contacts',
    description: 'The people/org index — also the email allowlist (docs/contacts.md). No delete (escape hatch).',
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
    slug: 'lifelog',
    name: 'Life logs',
    description: "First-person self-knowledge — the identity context's source. No delete (escape hatch).",
    // No-delete subset (decision 3 pattern); lifelog_delete rides the
    // `lifelog-admin` group. Matches CORE_AUTO_GRANT exactly so auto-granted
    // agents qualify for the group.
    toolSlugs: [...LIFELOG_AUTO_GRANT_SLUGS],
  },
  {
    slug: 'lifelog-admin',
    name: 'Life-log admin',
    description: 'Delete a life-log entry — deliberate-only; not on the persona.',
    toolSlugs: ['lifelog_delete'],
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
    description: 'Live web search (Perplexity Sonar via OpenRouter), standard + deep tiers.',
    toolSlugs: ['web_search', 'web_search_pro'],
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
    slug: 'federation',
    name: 'Federation',
    description: "Query other people's Mantles for data they've shared (docs/federation.md).",
    toolSlugs: ['peer_list', 'peer_query', 'peer_node_get'],
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
];

// ── Agents ───────────────────────────────────────────────────────────────────

export const MANIFEST_AGENTS: readonly ManifestAgent[] = [
  {
    slug: 'assistant',
    name: 'Assistant',
    description: 'The generalist persona — serves web /assistant and Telegram.',
    role: 'responder',
    model: 'anthropic/claude-sonnet-4.6',
    isPersona: true,
    // P6: grants are pure tool groups — the generalist's effective set is the
    // union of these bundles. Page/table AUTHORING is delegated to the Pages /
    // Ledger specialists (no `pages`/`tables`/`page-admin`); the persona keeps
    // `page-share` so it can publish. NOT granted: the `*-admin` deletes
    // (deliberate-only), `recall-search`/`research`/`terminal`/`federation`
    // (specialist). Versus the pre-P6 set this drops `contact_delete` +
    // `lifelog_delete` (now deliberate-only) — the one intentional removal.
    toolGroupSlugs: [
      'memory-core',
      'files',
      'notes',
      'events',
      'todos',
      'contacts',
      'lifelog',
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
      'location',
      'profile',
    ],
    skillSlugs: ['tool_grounding', 'voice_reply', 'rich_writing', 'location_awareness', 'navigation', 'integrations'],
    params: { temperature: 0.7, max_tokens: 16000 },
    priority: 100,
  },
  {
    slug: 'pages',
    name: 'Pages',
    description: 'Document authoring + editing specialist; backs the /pages Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-4.6',
    envModelVar: 'PAGES_MODEL',
    systemPrompt: AGENT_PROMPTS['pages']!,
    // P6: full page capability via groups — `pages` (authoring) + `page-admin`
    // (delete/overwrite) + `page-share` reassemble the complete PAGE_TOOL_SLUGS
    // set; `files`/`memory-core` cover source reads + cross-context lookups.
    // (Approach A: this coarsens to full `files`/`memory-core`, a benign gain.)
    toolGroupSlugs: ['pages', 'page-admin', 'page-share', 'files', 'memory-core'],
    skillSlugs: ['rich_writing', 'page_editing'],
    isDelegate: true,
    assistSurface: 'pages',
    params: { temperature: 0.3, max_tokens: 32000 },
    memoryConfig: { max_iterations: 20 },
    priority: 100,
  },
  {
    slug: 'tables',
    name: 'Ledger',
    description: 'Typed-grid + data specialist; backs the /tables Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-4.6',
    envModelVar: 'TABLES_MODEL',
    systemPrompt: AGENT_PROMPTS['tables']!,
    // P6: `tables` is the authoring subset (no `table-admin`/table_delete);
    // `files`/`memory-core` cover source reads + cross-context lookups.
    toolGroupSlugs: ['tables', 'files', 'memory-core'],
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
    model: 'anthropic/claude-sonnet-4.6',
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
    model: 'anthropic/claude-sonnet-4.6',
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
    slug: 'toolsmith',
    name: 'Toolsmith',
    description: 'API integration specialist — reads service docs, authors + tests agent-callable HTTP tools; backs the API Console Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-sonnet-4.6',
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
      'Mini-app builder — writes real TSX against the app\'s shadcn UI + theme, bundles with esbuild, renders in a sandbox; backs the /apps Assist panel.',
    role: 'custom',
    model: 'anthropic/claude-opus-4.8',
    envModelVar: 'APPSMITH_MODEL',
    systemPrompt: AGENT_PROMPTS['appsmith']!,
    // `apps` (authoring) + `app-admin` (delete/publish) reassemble the full
    // APP_TOOL_SLUGS set; `files`/`memory-core` for source reads + lookups;
    // `delegation` so it can hand data-tool work to the toolsmith.
    toolGroupSlugs: ['apps', 'app-admin', 'files', 'memory-core', 'delegation'],
    skillSlugs: ['app_authoring'],
    isDelegate: true,
    assistSurface: 'apps',
    params: { temperature: 0.2, max_tokens: 32000 },
    // Codegen → build → read-errors → fix loops chew iterations. delegate_to
    // toolsmith: Appsmith doesn't author HTTP tools, it delegates that.
    memoryConfig: { max_iterations: 30, delegate_to: ['toolsmith'] },
    priority: 100,
  },
];

// ── Workers ──────────────────────────────────────────────────────────────────

export const MANIFEST_WORKERS: readonly ManifestWorker[] = [
  { kind: 'extractor', name: 'Extractor', model: 'google/gemini-3.1-flash-lite', required: true },
  { kind: 'summarizer', name: 'Summarizer', model: 'google/gemini-3.1-flash-lite', required: true },
  { kind: 'reflector', name: 'Reflector', model: 'google/gemini-3.1-flash-lite', required: true },
  { kind: 'document', name: 'Document reader', model: 'google/gemini-3.1-flash-lite', required: true },
  { kind: 'vision', name: 'Read images', model: 'google/gemini-3.1-flash-lite', required: false },
  { kind: 'image_gen', name: 'Image generation', model: 'google/gemini-3.1-flash-image-preview', required: false },
  { kind: 'tts', name: 'Assistant voice', model: 'x-ai/grok-voice-tts-1.0', required: false },
  { kind: 'stt', name: 'Transcribe voice', model: 'openai/gpt-4o-mini-transcribe', required: false },
  // Web search tiers (Perplexity Sonar via OpenRouter). The researcher's
  // `web_search` uses the cheap/fast tier; `web_search_pro` the stronger one.
  { kind: 'search', name: 'Web search', model: 'perplexity/sonar', required: false },
  { kind: 'search_advanced', name: 'Deep web search', model: 'perplexity/sonar-pro', required: false },
];

// ── Derived selectors (single computation; kills the duplication) ────────────

/** Slug of the persona agent (the delegation entry point). */
export const PERSONA_SLUG = MANIFEST_AGENTS.find((a) => a.isPersona)!.slug;

/** The persona's default tool grant (P6: pure tool GROUPS — the generalist's
 *  whole capability). Onboarding seeds a fresh persona with exactly these. */
export const PERSONA_TOOL_GROUP_SLUGS: readonly string[] =
  MANIFEST_AGENTS.find((a) => a.isPersona)!.toolGroupSlugs ?? [];

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
