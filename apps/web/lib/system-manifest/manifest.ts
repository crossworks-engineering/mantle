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
  DEFAULT_ASSISTANT_TOOL_SLUGS,
  PAGE_TOOL_SLUGS,
  TABLE_TOOL_SLUGS,
} from '@mantle/tools';
import type { AiWorkerKind } from '@mantle/db';
import { SKILL_INSTRUCTIONS, AGENT_PROMPTS } from './prompts';

// ── Types ────────────────────────────────────────────────────────────────────

export type ManifestSkill = {
  slug: string;
  name: string;
  description: string;
  /** DEPRECATED as of P1 (docs/tools-and-skills.md): manifest skills are pure
   *  teaching and carry NO tools — capability is granted to agents directly
   *  (and, from P3, via tool groups). Always `[]` here; the `skills.tool_slugs`
   *  column is retired in P4. (NB: heartbeat skills, which are not in this
   *  manifest, may still carry tools — a separate mechanism.) */
  toolSlugs: string[];
  /** The skill body rendered into the system prompt (verbatim, from ./prompts). */
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
  /** Tool grant. The sentinel resolves to DEFAULT_ASSISTANT_TOOL_SLUGS so the
   *  persona tracks the registry rather than a frozen copy. */
  toolSlugs: string[] | 'DEFAULT_ASSISTANT';
  /** Extra direct tool grants unioned on top of `toolSlugs` — the escape hatch
   *  (decision 2, docs/tools-and-skills.md) for one-off grants that don't belong
   *  in the base set or a group. Used to preserve `page_delete` on the persona
   *  (decision 1) now that it no longer rides in via the `rich_writing` skill. */
  extraToolSlugs?: string[];
  /** Skills that SHOULD be attached to this agent. */
  skillSlugs: string[];
  /** Tool groups granted to this agent (named bundles). Phase 0: dormant —
   *  seeded onto the agent but NOT yet expanded into its effective tool set.
   *  Omitted ⇒ none. See docs/tools-and-skills.md. */
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

/** Page authoring set: every page tool except the destructive delete and the
 *  live-overwrite path (edits go through page_update_draft). */
const PAGE_AUTHORING_TOOL_SLUGS = PAGE_TOOL_SLUGS.filter(
  (s) => s !== 'page_delete' && s !== 'page_update',
);
/** Table authoring set: every table tool except the irreversible delete. */
const TABLE_AUTHORING_TOOL_SLUGS = TABLE_TOOL_SLUGS.filter((s) => s !== 'table_delete');

const SOURCE_FILE_TOOLS = ['file_read', 'file_list', 'file_get', 'folder_list'];
const CROSS_CONTEXT_TOOLS = ['search_nodes', 'node_read'];

// ── Skills ───────────────────────────────────────────────────────────────────

export const MANIFEST_SKILLS: readonly ManifestSkill[] = [
  {
    slug: 'tool_grounding',
    name: 'Tool grounding',
    description: 'Search/verify before answering — never answer from memory alone.',
    toolSlugs: [],
    instructions: SKILL_INSTRUCTIONS['tool_grounding']!,
  },
  {
    slug: 'voice_reply',
    name: 'Voice reply',
    description: 'How to write replies that will be spoken aloud (TTS).',
    toolSlugs: [],
    instructions: SKILL_INSTRUCTIONS['voice_reply']!,
  },
  {
    slug: 'page_editing',
    name: 'Page editing',
    description: 'Safe, scalable page authoring/editing; preserve words verbatim, prefer block tools.',
    toolSlugs: [], // P1: pure teaching — page tools granted to agents directly.
    instructions: SKILL_INSTRUCTIONS['page_editing']!,
  },
  {
    slug: 'rich_writing',
    name: 'Rich writing',
    description: 'The rich Mantle dialect: callouts, columns, tables, task lists, KaTeX.',
    toolSlugs: [], // P1: pure teaching — page tools granted to agents directly.
    instructions: SKILL_INSTRUCTIONS['rich_writing']!,
  },
  {
    slug: 'table_authoring',
    name: 'Table authoring',
    description: 'Build typed grids: columns, totals, formulas, views; edit by stable row/col id.',
    toolSlugs: [], // P1: pure teaching — table tools granted to agents directly.
    instructions: SKILL_INSTRUCTIONS['table_authoring']!,
  },
  {
    slug: 'mantle-ops',
    name: 'Mantle ops',
    description: 'How Mantle works + the operating workflow (for the coder agent).',
    toolSlugs: [],
    instructions: SKILL_INSTRUCTIONS['mantle-ops']!,
  },
];

// ── Tool groups ──────────────────────────────────────────────────────────────
//
// Named, capability-only bundles (docs/tools-and-skills.md). The membership
// mirrors the `*_TOOLS` clusters that already exist in @mantle/tools — these
// ARE the seed bundles. Phase 0 seeds them; nothing grants them yet (every
// agent's toolGroupSlugs is empty), so the system is unchanged at runtime. The
// drift-test validates every slug here against KNOWN_TOOL_SLUGS.
//
// Per decision 3 (docs/tools-and-skills.md): the `pages`/`tables` groups carry
// the AUTHORING subsets — destructive `page_delete`/`table_delete` are granted
// only where intended via the direct-grant escape hatch, never via the group.

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
    description: 'Author + edit rich pages (authoring subset; no destructive delete).',
    toolSlugs: [...PAGE_AUTHORING_TOOL_SLUGS],
  },
  {
    slug: 'tables',
    name: 'Tables toolkit',
    description: 'Build + edit typed grids (authoring subset; no destructive delete).',
    toolSlugs: [...TABLE_AUTHORING_TOOL_SLUGS],
  },
  {
    slug: 'contacts',
    name: 'Contacts',
    description: 'The people/org index — also the email allowlist (docs/contacts.md).',
    toolSlugs: ['contact_find', 'contact_list', 'contact_get', 'contact_create', 'contact_update', 'contact_delete'],
  },
  {
    slug: 'lifelog',
    name: 'Life logs',
    description: "First-person self-knowledge — the identity context's source.",
    toolSlugs: ['lifelog_create', 'lifelog_list', 'lifelog_get', 'lifelog_update', 'lifelog_delete'],
  },
  {
    slug: 'recall',
    name: 'Recall',
    description: 'Time-windowed replay of past conversations.',
    toolSlugs: ['find_window', 'recall_window'],
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
    toolSlugs: 'DEFAULT_ASSISTANT',
    // P1: page_delete used to ride in via the rich_writing skill (now tool-less).
    // Preserved as an explicit direct grant (decision 1) — the deny-set keeps it
    // out of DEFAULT_ASSISTANT, so this is the one deliberate exception.
    extraToolSlugs: ['page_delete'],
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
    // P1: full page set (incl. page_delete/page_update) — previously granted via
    // the rich_writing skill, now direct. Skills are pure teaching.
    toolSlugs: [...PAGE_TOOL_SLUGS, ...SOURCE_FILE_TOOLS, ...CROSS_CONTEXT_TOOLS],
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
    toolSlugs: [...TABLE_AUTHORING_TOOL_SLUGS, ...SOURCE_FILE_TOOLS, ...CROSS_CONTEXT_TOOLS],
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
    toolSlugs: ['find_window', 'recall_window', 'search_nodes', 'node_read'],
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
    toolSlugs: ['web_search', 'search_nodes', 'node_read'],
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
    toolSlugs: [
      'run_terminal',
      'file_create',
      'file_read',
      'file_get',
      'file_list',
      'folder_list',
      'folder_get_by_path',
      'search_nodes',
      'node_read',
      'tree_list',
    ],
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

/** Resolve an agent's tool grant (expanding the DEFAULT_ASSISTANT sentinel). */
export function resolveManifestToolSlugs(agent: ManifestAgent): string[] {
  const base =
    agent.toolSlugs === 'DEFAULT_ASSISTANT'
      ? [...DEFAULT_ASSISTANT_TOOL_SLUGS]
      : [...agent.toolSlugs];
  if (agent.extraToolSlugs) {
    for (const s of agent.extraToolSlugs) if (!base.includes(s)) base.push(s);
  }
  return base;
}

/**
 * Decompose a flat tool grant into group grants + a residual (Phase 3, the
 * "break up the god-grant" transform). Greedy: grant every tool group whose
 * member tools are ALL present in `full`; the residual is everything not covered
 * by a granted group (true one-offs that ride the direct escape hatch).
 *
 * INVARIANT (behavior-identical): `residual ∪ ⋃(granted group tools) === full`
 * (as sets). The runtime's effectiveToolSlugs reassembles exactly this, so an
 * agent's effective tools are unchanged by re-expression. Deterministic — order
 * follows MANIFEST_TOOL_GROUPS. Used by the seeder, onboarding, and the dev
 * re-expression script so all three agree.
 */
export function deriveGroupGrants(full: string[]): {
  toolSlugs: string[];
  toolGroupSlugs: string[];
} {
  const have = new Set(full);
  const granted: string[] = [];
  const covered = new Set<string>();
  for (const g of MANIFEST_TOOL_GROUPS) {
    if (g.toolSlugs.length === 0) continue;
    if (g.toolSlugs.every((t) => have.has(t))) {
      granted.push(g.slug);
      for (const t of g.toolSlugs) covered.add(t);
    }
  }
  const residual = full.filter((t) => !covered.has(t));
  return { toolSlugs: residual, toolGroupSlugs: granted };
}

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
