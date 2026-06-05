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
  TABLE_TOOL_SLUGS,
  CONTACT_AUTO_GRANT_SLUGS,
  LIFELOG_AUTO_GRANT_SLUGS,
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
  /** Binds the /pages or /tables editor "Assist" panel to this agent. */
  assistSurface?: 'pages' | 'tables';
  params: { temperature: number; max_tokens?: number };
  memoryConfig?: { max_iterations?: number };
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
 *  destructive delete + live-overwrite (those ride the `page-admin` group) and
 *  the sharing toggles (which ride the standalone `page-share` group so the
 *  persona can share without holding the authoring toolkit). No overlap between
 *  the `pages`, `page-admin`, and `page-share` groups. */
const PAGE_AUTHORING_TOOL_SLUGS = PAGE_TOOL_SLUGS.filter(
  (s) => !['page_delete', 'page_update', 'page_share', 'page_unshare'].includes(s),
);
/** Table authoring set: every table tool except the irreversible delete. */
const TABLE_AUTHORING_TOOL_SLUGS = TABLE_TOOL_SLUGS.filter((s) => s !== 'table_delete');

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
    description: 'The rich Mantle dialect: callouts, columns, tables, task lists, KaTeX.',
    instructions: SKILL_INSTRUCTIONS['rich_writing']!,
  },
  {
    slug: 'table_authoring',
    name: 'Table authoring',
    description: 'Build typed grids: columns, totals, formulas, views; edit by stable row/col id.',
    instructions: SKILL_INSTRUCTIONS['table_authoring']!,
  },
  {
    slug: 'mantle-ops',
    name: 'Mantle ops',
    description: 'How Mantle works + the operating workflow (for the coder agent).',
    instructions: SKILL_INSTRUCTIONS['mantle-ops']!,
  },
];

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
    description: 'Read source files + folders, and create files.',
    toolSlugs: ['folder_list', 'folder_get_by_path', 'file_list', 'file_get', 'file_read', 'file_create'],
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
    description: 'Author + edit rich pages (authoring subset; no delete/overwrite/share).',
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
    slug: 'tables',
    name: 'Tables toolkit',
    description: 'Build + edit typed grids (authoring subset; no destructive delete).',
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
    description: 'Live web search (Perplexity Sonar via OpenRouter).',
    toolSlugs: ['web_search'],
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
    ],
    skillSlugs: ['tool_grounding', 'voice_reply', 'rich_writing'],
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

/** surface → default specialist slug, for the editor Assist panels. */
export const ASSIST_SURFACE_DEFAULTS: Record<'pages' | 'tables', string> = Object.fromEntries(
  MANIFEST_AGENTS.filter((a) => a.assistSurface).map((a) => [a.assistSurface!, a.slug]),
) as Record<'pages' | 'tables', string>;

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

/** The set of tool slugs the manifest is allowed to reference. */
export const KNOWN_TOOL_SLUGS: ReadonlySet<string> = new Set<string>([
  ...BUILTIN_TOOLS.map((t) => t.slug),
  ...KNOWN_EXTERNAL_TOOL_SLUGS,
]);

/** Slugs of every manifest tool group (the set an agent may reference). */
export const KNOWN_TOOL_GROUP_SLUGS: ReadonlySet<string> = new Set<string>(
  MANIFEST_TOOL_GROUPS.map((g) => g.slug),
);

export const SYSTEM_MANIFEST = {
  skills: MANIFEST_SKILLS,
  toolGroups: MANIFEST_TOOL_GROUPS,
  agents: MANIFEST_AGENTS,
  workers: MANIFEST_WORKERS,
} as const;
