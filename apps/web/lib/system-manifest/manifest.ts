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
  /** Builtin tool slugs this skill bundles (unioned into an agent's allowlist
   *  when attached). Empty for behaviour-only skills. */
  toolSlugs: string[];
  /** The skill body rendered into the system prompt (verbatim, from ./prompts). */
  instructions: string;
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
  /** Skills that SHOULD be attached to this agent. */
  skillSlugs: string[];
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
    toolSlugs: PAGE_AUTHORING_TOOL_SLUGS,
    instructions: SKILL_INSTRUCTIONS['page_editing']!,
  },
  {
    slug: 'rich_writing',
    name: 'Rich writing',
    description: 'The rich Mantle dialect: callouts, columns, tables, task lists, KaTeX.',
    toolSlugs: [...PAGE_TOOL_SLUGS],
    instructions: SKILL_INSTRUCTIONS['rich_writing']!,
  },
  {
    slug: 'table_authoring',
    name: 'Table authoring',
    description: 'Build typed grids: columns, totals, formulas, views; edit by stable row/col id.',
    toolSlugs: TABLE_AUTHORING_TOOL_SLUGS,
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
    toolSlugs: [...PAGE_AUTHORING_TOOL_SLUGS, ...SOURCE_FILE_TOOLS, ...CROSS_CONTEXT_TOOLS],
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
  return agent.toolSlugs === 'DEFAULT_ASSISTANT'
    ? [...DEFAULT_ASSISTANT_TOOL_SLUGS]
    : agent.toolSlugs;
}

export const SYSTEM_MANIFEST = {
  skills: MANIFEST_SKILLS,
  agents: MANIFEST_AGENTS,
  workers: MANIFEST_WORKERS,
} as const;
