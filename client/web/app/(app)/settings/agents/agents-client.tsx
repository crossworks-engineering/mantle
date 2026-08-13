'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Switch } from '@mantle/web-ui/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { FieldHint, hintId } from '@mantle/web-ui/ui/field-hint';
import { ModelSelect } from '@/components/ui/model-select';
import { Slider } from '@mantle/web-ui/ui/slider';
import { useToast } from '@mantle/web-ui/ui/toast';
import { ListCard } from '@mantle/web-ui/ui/list-card';
import type { ExplorerModel } from '@server/lib/model-explorer';
import { getProvider, isProviderWired, providersForCapability } from '@mantle/voice/client';
import type {
  AgentDTO,
  AgentAvatarDTO,
  AgentMemoryConfigDTO,
  SkillDTO,
  ToolGroupWithRefs,
  AiWorkerDTO,
} from '@mantle/client-types';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { invalidateAgentQueries } from '@mantle/web-ui/agent-invalidation';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { AvatarPicker } from '@/components/avatar-picker';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { ToggleList, type ToggleListItem } from '@/components/toggle-list';
import { TelegramBotSection } from '@/components/telegram/telegram-bot-section';
import { GeneratedAvatar } from '@mantle/web-ui/generated-avatar';
import { useAvatarStyle } from '@mantle/web-ui/avatar-style-provider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mantle/web-ui/ui/tabs';
import { PersonaNotesEditor } from './persona-notes-editor';
import { ChatTestButton } from '@/components/settings/chat-test-button';
import { ModelsTab } from './models-tab';
import {
  BackupRouteSection,
  MemorySection,
  RouteHostFields,
  SELECT_CLASS,
  TEXTAREA_CLASS,
} from './agent-form-sections';
import { slugify } from '@mantle/web-ui/slugify';

// The embedder is no longer agent-configurable — it's the single
// `embedding_config` row, managed at /settings/embedding (migration 0061).

// The static MODEL_SUGGESTIONS list was retired with the ModelSelect rollout —
// the form now reads the full live OpenRouter catalog (~330+ models) from
// /api/models?provider=openrouter and the combobox handles search + sort.
// Custom slugs the catalog hasn't indexed yet still commit via the
// "Use ‹typed›" affordance inside the combobox.

const ROLES = [
  { value: 'assistant', label: 'Assistant — interactive chat surface' },
  { value: 'responder', label: 'Responder — replies to Telegram / async DMs' },
  { value: 'extractor', label: 'Extractor — summary + facts + entities at ingest' },
  { value: 'summarizer', label: 'Summarizer — Tier-2 conversation rollups' },
  { value: 'reflector', label: 'Reflector — appends persona notes from dialog' },
  { value: 'worker', label: 'Worker — runner-queue step executor (proposes, never chats)' },
  { value: 'custom', label: 'Custom' },
] as const;

type Role = (typeof ROLES)[number]['value'];

/** Sub-tabs of the per-agent editor (the right master-detail pane). Local
 *  state only — `?tab=` belongs to the outer Agents|Models switcher and
 *  `?selected=` deep links are one-shot, so the section is deliberately not
 *  URL-driven. Every `TabsContent` carries `data-agent-section` so submit
 *  validation can jump to the tab holding the first invalid field. */
type AgentSection = 'general' | 'model' | 'behaviour' | 'memory' | 'learned';

// Wire shapes come from @mantle/client-types (the `/api/**` contract); the local
// names below keep the rest of this file unchanged. `AgentSummary` is the agent
// DTO; the others are aliases for the jsonb sub-shapes the form reads/writes.
type MemoryConfig = AgentMemoryConfigDTO;
type AgentAvatar = AgentAvatarDTO;

type AgentSummary = AgentDTO;

type ApiKeyOption = { id: string; service: string; label: string; masked: string };

/** A `kind='tts'` ai_worker, for the per-agent voice picker. */
type TtsWorkerOption = {
  id: string;
  slug: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
};

export type SkillOption = {
  slug: string;
  name: string;
  description: string;
};

export type ToolGroupOption = {
  slug: string;
  name: string;
  description: string;
  /** Member tool slugs — used to compute the agent's effective tool set. */
  toolSlugs: string[];
};

const DEFAULT_SYSTEM_PROMPT = `You are an assistant helping the user via Telegram. You have memory of the recent conversation in this chat. Be concise and conversational — short paragraphs, no headers, no bullet lists unless explicitly useful. Match the tone of the incoming message. Skip pleasantries unless they fit naturally. If you don't know something or can't help, say so plainly.`;

const DEFAULT_SUMMARIZER_PROMPT = `You are a memory compressor for an ongoing Telegram conversation. You will be given a chronological transcript of a chat between the user and an AI assistant, with each line prefixed by its 1-indexed turn number.

Group the transcript into TOPICS — contiguous stretches of turns about a single subject. A short batch is often one topic; a longer batch may contain several. Don't force splits.

For each topic, produce:
  - A short label (2-5 words, title case)
  - A factual summary (3-6 sentences, no headers, no bullet lists) capturing decisions, commitments, specific facts about people/places/dates/numbers
  - The turn numbers belonging to this topic (contiguous range; topics don't overlap)

Be specific — write "Maria is presenting the Q3 report on Thursday" not "they discussed work plans."

Output STRICT JSON:

{ "topics": [ { "label": "...", "summary": "...", "turn_indexes": [1, 2, 3] } ] }

Every turn number must appear exactly once across all topics combined.`;

const DEFAULT_EXTRACTOR_PROMPT = `You are a memory extractor for a personal AI assistant. You will be given the title and body of a piece of content (a note, document, email, etc.) belonging to a single user. Your job is to produce THREE outputs:

1. A 1-2 sentence summary of what this content is about. Be specific — names, dates, projects, numbers. Avoid filler.

2. A list of facts about the user or their world that this content reveals. Each fact is a single declarative sentence with the entities mentioned (people, projects, places, organisations, events) for cross-referencing.

3. A list of relations: direct relationships BETWEEN two named entities the content establishes (Sarah works_at Acme, Tom father_of Lena). These build the user's knowledge graph.

Output STRICT JSON, no markdown:

{
  "summary": "<1-2 sentences>",
  "facts": [{ "content": "<sentence>", "kind": "factual|episodic|semantic|preference", "confidence": 0.0-1.0, "entities": [{ "name": "...", "kind": "person|project|place|org|event" }] }],
  "entities": [{ "name": "...", "kind": "..." }],
  "relations": [{ "subject": "<entity name>", "relation": "<verb>", "object": "<entity name>", "confidence": 0.0-1.0 }]
}

Guidelines:
- factual = verifiable claim with a value.
- episodic = something that happened on a date.
- semantic = a stable abstract identity.
- preference = how the user prefers to be helped.
- Relations: subject + object must be names in your "entities" list; "relation" is a short lowercase snake_case verb; subject → relation → object reads as a sentence; never relate an entity to itself; omit below 0.6 confidence. PREFER + REUSE common verbs over coining near-synonyms (employed_by not works_at/receives_salary_from; banks_with not holds_account_at; located_in; owns; married_to; member_of; invoiced_by; provides_services_to) — a consistent vocabulary keeps the graph queryable. Coin a new verb only when none fits.
- Be conservative on confidence — 1.0 only for explicit; 0.5-0.8 for reasonable inferences.
- DO NOT extract secrets, passwords, or credentials.`;

const DEFAULT_REFLECTOR_PROMPT = `You are a reflector for a personal AI assistant. You will be given a transcript of recent exchanges + the assistant's current persona_notes. Spot NEW signals worth remembering, AND ONLY new ones.

Look for: style hints (response format preferences), relationship notes (how user and assistant interact), corrections (when the user said something is wrong).

Output STRICT JSON, no markdown:

{ "new_notes": [{ "kind": "style|relationship|correction", "content": "<single declarative sentence>" }] }

Rules:
- Skip anything already covered by an existing persona_note.
- Be specific — "the user prefers terse, no-bullet replies" beats "user likes brevity".
- Don't invent — only return notes grounded in the transcript.
- Return an EMPTY new_notes array if nothing notable surfaces.
- Don't include trivia about content (those belong in facts, not persona).`;

/** Defaults for a fresh agent row, keyed by role. */
function defaultsForRole(role: Role): {
  model: string;
  systemPrompt: string;
  historyLimit: string;
  digestLimit: string;
  summarizeThreshold: string;
  summarizeBatch: string;
  extractTypes: string;
  factLimit: string;
  contentHitLimit: string;
} {
  if (role === 'summarizer') {
    return {
      model: 'anthropic/claude-haiku-4.5',
      systemPrompt: DEFAULT_SUMMARIZER_PROMPT,
      historyLimit: '0', // summarizer doesn't use history; the transcript IS the input
      digestLimit: '0',
      summarizeThreshold: '30',
      summarizeBatch: '20',
      extractTypes: '',
      factLimit: '0',
      contentHitLimit: '0',
    };
  }
  if (role === 'extractor') {
    return {
      model: 'anthropic/claude-haiku-4.5',
      systemPrompt: DEFAULT_EXTRACTOR_PROMPT,
      historyLimit: '0',
      digestLimit: '0',
      summarizeThreshold: '30',
      summarizeBatch: '20',
      extractTypes: 'note',
      factLimit: '0',
      contentHitLimit: '0',
    };
  }
  if (role === 'reflector') {
    return {
      model: 'anthropic/claude-haiku-4.5',
      systemPrompt: DEFAULT_REFLECTOR_PROMPT,
      historyLimit: '0',
      digestLimit: '0',
      summarizeThreshold: '30',
      summarizeBatch: '20',
      extractTypes: '',
      factLimit: '0',
      contentHitLimit: '0',
    };
  }
  return {
    model: 'anthropic/claude-sonnet-5',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    historyLimit: '20',
    digestLimit: '3',
    summarizeThreshold: '30',
    summarizeBatch: '20',
    extractTypes: '',
    factLimit: '10',
    // 5, not 3 — a 3-hit window dropped genuinely relevant near-misses below the
    // prompt (see docs/recall-eval.md). Five short summaries cost little.
    contentHitLimit: '5',
  };
}

export type FormState = {
  slug: string;
  name: string;
  description: string;
  role: Role;
  /** Provider id. Defaults to 'openrouter' on new agents; legacy rows
   *  read it from the column (backfilled to 'openrouter' by 0048). */
  provider: string;
  model: string;
  apiKeyId: string;
  /** Optional BACKUP chat route. Unlike embeddings, may be a different model. */
  backupEnabled: boolean;
  backupProvider: string;
  backupModel: string;
  backupApiKeyId: string;
  /** Per-route host + tailnet flag (migration 0063). Empty baseUrl = provider
   *  default; viaTailnet routes through the Tailscale proxy. */
  baseUrl: string;
  viaTailnet: boolean;
  backupBaseUrl: string;
  backupViaTailnet: boolean;
  /** Pinned TTS worker id; '' = use the owner's default TTS worker. */
  ttsWorkerId: string;
  systemPrompt: string;
  priority: string;
  enabled: boolean;
  historyLimit: string;
  historyWindowHours: string;
  digestLimit: string;
  factLimit: string;
  contentHitLimit: string;
  summarizeThreshold: string;
  summarizeBatch: string;
  extractTypes: string;
  extractFacts: boolean;
  /** Cap in cents (UI-friendlier than micro-USD; converted on save). Empty = no cap. */
  extractCostCapCents: string;
  skillSlugs: string[];
  /** Tool groups granted to this agent — the sole capability control (P6). */
  toolGroupSlugs: string[];
  /** Agent slugs this agent may delegate to via invoke_agent. */
  delegateTo: string[];
  /** Tool-result spill thresholds (KB, as strings). Empty = global default. */
  resultInlineMaxKb: string;
  resultEmbedMinKb: string;
  resultSpillMaxKb: string;
  temperature: string;
  maxTokens: string;
  /** Suggest a follow-up question after each reply (the suggester worker's
   *  chip in the chat composer). One extra cheap LLM call per turn, so off by
   *  default. */
  suggestFollowUp: boolean;
  /** Avatar {style, seed}; null = initials fallback. */
  avatar: AgentAvatar | null;
};

function emptyForm(role: Role = 'responder'): FormState {
  const d = defaultsForRole(role);
  return {
    slug: '',
    name: '',
    description: '',
    role,
    provider: 'openrouter',
    model: d.model,
    apiKeyId: '',
    backupEnabled: false,
    backupProvider: 'openrouter',
    backupModel: '',
    backupApiKeyId: '',
    baseUrl: '',
    viaTailnet: false,
    backupBaseUrl: '',
    backupViaTailnet: false,
    ttsWorkerId: '',
    systemPrompt: d.systemPrompt,
    priority: '100',
    enabled: true,
    historyLimit: d.historyLimit,
    historyWindowHours: '',
    digestLimit: d.digestLimit,
    factLimit: d.factLimit,
    contentHitLimit: d.contentHitLimit,
    summarizeThreshold: d.summarizeThreshold,
    summarizeBatch: d.summarizeBatch,
    extractTypes: d.extractTypes,
    extractFacts: true,
    extractCostCapCents: '',
    skillSlugs: [],
    toolGroupSlugs: [],
    delegateTo: [],
    resultInlineMaxKb: '',
    resultEmbedMinKb: '',
    resultSpillMaxKb: '',
    temperature: '0.7',
    maxTokens: '',
    suggestFollowUp: false,
    avatar: null,
  };
}

function formFromAgent(a: AgentSummary): FormState {
  const d = defaultsForRole(a.role);
  return {
    slug: a.slug,
    name: a.name,
    description: a.description ?? '',
    role: a.role,
    provider: a.provider,
    model: a.model,
    apiKeyId: a.apiKeyId ?? '',
    backupEnabled: a.backupEnabled,
    backupProvider: a.backupProvider ?? 'openrouter',
    backupModel: a.backupModel ?? '',
    backupApiKeyId: a.backupApiKeyId ?? '',
    baseUrl: a.baseUrl ?? '',
    viaTailnet: a.viaTailnet,
    backupBaseUrl: a.backupBaseUrl ?? '',
    backupViaTailnet: a.backupViaTailnet,
    ttsWorkerId: a.ttsWorkerId ?? '',
    systemPrompt: a.systemPrompt,
    priority: String(a.priority),
    enabled: a.enabled,
    historyLimit: a.memoryConfig.history_limit?.toString() ?? d.historyLimit,
    historyWindowHours: a.memoryConfig.history_window_hours?.toString() ?? '',
    digestLimit: a.memoryConfig.digest_limit?.toString() ?? d.digestLimit,
    factLimit: a.memoryConfig.fact_limit?.toString() ?? d.factLimit,
    contentHitLimit: a.memoryConfig.content_hit_limit?.toString() ?? d.contentHitLimit,
    summarizeThreshold: a.memoryConfig.summarize_threshold?.toString() ?? d.summarizeThreshold,
    summarizeBatch: a.memoryConfig.summarize_batch?.toString() ?? d.summarizeBatch,
    extractTypes: a.memoryConfig.extract_types?.join(',') ?? d.extractTypes,
    extractFacts: a.memoryConfig.extract_facts ?? true,
    extractCostCapCents:
      a.memoryConfig.extract_cost_cap_micro_usd != null
        ? (a.memoryConfig.extract_cost_cap_micro_usd / 10_000).toString()
        : '',
    skillSlugs: a.skillSlugs ?? [],
    toolGroupSlugs: a.toolGroupSlugs ?? [],
    delegateTo: a.memoryConfig.delegate_to ?? [],
    resultInlineMaxKb: a.memoryConfig.result_handling?.inline_max_kb?.toString() ?? '',
    resultEmbedMinKb: a.memoryConfig.result_handling?.embed_min_kb?.toString() ?? '',
    resultSpillMaxKb: a.memoryConfig.result_handling?.spill_max_kb?.toString() ?? '',
    temperature: a.params.temperature?.toString() ?? '0.7',
    maxTokens: a.params.max_tokens?.toString() ?? '',
    suggestFollowUp: a.params.suggest_follow_up === true,
    avatar: a.avatar ?? null,
  };
}

/** Map a sampling temperature (0–2) to a human descriptor + hint. */
function tempDescriptor(t: number): { word: string; hint: string } {
  if (t <= 0.3)
    return {
      word: 'Precise',
      hint: 'Deterministic and focused — best for extraction, classification, and exact formats.',
    };
  if (t <= 0.7)
    return {
      word: 'Grounded',
      hint: 'Mostly consistent with a little flexibility — a safe default for assistants.',
    };
  if (t <= 1.0)
    return {
      word: 'Balanced',
      hint: 'A natural mix of reliability and variation for everyday conversation.',
    };
  if (t <= 1.4)
    return {
      word: 'Creative',
      hint: 'More varied and expressive — good for brainstorming and richer writing.',
    };
  return { word: 'Wild', hint: 'Highly random and surprising — it may wander or go off-topic.' };
}

export function AgentsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();
  // The brain's avatar style — stamped onto avatars this screen saves so the
  // stored row matches what everything actually renders.
  const { avatarStyle } = useAvatarStyle();
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  const [saving, setSaving] = useState(false);

  // All data is client-fetched against `/api/**` (Phase 2 · Task 4) — no
  // SSR props, so the screen carries no in-process DB read. Query keys mirror
  // the URLs; mutations invalidate `['agents']` (the client-side replacement
  // for router.refresh()).
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiFetch<{ agents: AgentSummary[] }>('/api/agents').then((r) => r.agents),
  });
  const keysQuery = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiFetch<{ keys: ApiKeyOption[] }>('/api/keys').then((r) => r.keys),
  });
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => apiFetch<{ skills: SkillDTO[] }>('/api/skills').then((r) => r.skills),
  });
  const toolGroupsQuery = useQuery({
    queryKey: ['tool-groups'],
    queryFn: () =>
      apiFetch<{ groups: ToolGroupWithRefs[] }>('/api/tool-groups').then((r) => r.groups),
  });
  const ttsWorkersQuery = useQuery({
    queryKey: ['ai-workers'],
    queryFn: () => apiFetch<{ workers: AiWorkerDTO[] }>('/api/ai-workers').then((r) => r.workers),
  });
  const tailnetQuery = useQuery({
    queryKey: ['tailnet', 'peers'],
    queryFn: () => apiFetch<{ peers: string[] }>('/api/tailscale/peers').then((r) => r.peers),
  });

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const apiKeys = keysQuery.data ?? [];
  const tailnetPeers = tailnetQuery.data ?? [];
  // Only enabled skills / tool groups are grantable; TTS pickers want kind='tts'.
  const availableSkills = useMemo<SkillOption[]>(
    () =>
      (skillsQuery.data ?? [])
        .filter((s) => s.enabled)
        .map((s) => ({ slug: s.slug, name: s.name, description: s.description })),
    [skillsQuery.data],
  );
  const availableToolGroups = useMemo<ToolGroupOption[]>(
    () =>
      (toolGroupsQuery.data ?? [])
        .filter((g) => g.enabled)
        .map((g) => ({
          slug: g.slug,
          name: g.name,
          description: g.description,
          toolSlugs: g.toolSlugs,
        })),
    [toolGroupsQuery.data],
  );
  const ttsWorkers = useMemo<TtsWorkerOption[]>(
    () =>
      (ttsWorkersQuery.data ?? [])
        .filter((w) => w.kind === 'tts')
        .map((w) => ({
          id: w.id,
          slug: w.slug,
          name: w.name,
          provider: w.provider,
          model: w.model,
          enabled: w.enabled,
          isDefault: w.isDefault,
        })),
    [ttsWorkersQuery.data],
  );

  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; agent: AgentSummary }
  >();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  // Kept across agent switches (handy for comparing the same setting across
  // agents); only bounced off `learned`, which create mode doesn't render.
  const [section, setSection] = useState<AgentSection>('general');

  // The agent's effective tool set = the union of every granted group's tools
  // (exactly what the runtime resolves; P6 — tool groups are the sole grant).
  // Surfaced read-only so the operator sees the agent's TRUE capability.
  const effectiveTools = useMemo(() => {
    const byGroup = new Map(availableToolGroups.map((g) => [g.slug, g.toolSlugs]));
    const set = new Set<string>();
    for (const g of form.toolGroupSlugs) for (const t of byGroup.get(g) ?? []) set.add(t);
    return [...set].sort();
  }, [form.toolGroupSlugs, availableToolGroups]);

  // Live model → context-window map (OpenRouter catalog, cached server-side),
  // fetched once so the Model field can show the real window for the typed
  // slug — the same source the dashboard's context-% bars use.
  const [contextLimits, setContextLimits] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ limits?: Record<string, number> }>('/api/model-context')
      .then((d) => {
        if (!cancelled && d?.limits) setContextLimits(d.limits as Record<string, number>);
      })
      .catch(() => {
        /* readout is decorative — ignore fetch failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live model catalog for the form's currently-selected provider.
  // OpenRouter returns ~330+ models with name + context + pricing +
  // modality; direct providers return a slimmer shape (id + display
  // name + context; pricing usually absent — the /models page explorer
  // is the source of truth for cost data). The ModelSelect combobox
  // handles missing pricing gracefully (sinks unpriced rows to the
  // bottom, skips the price badge).
  //
  // Re-fetches whenever form.provider changes so switching the
  // dropdown from OpenRouter to Anthropic-direct (etc.) lists the
  // RIGHT slugs — pre-Phase-3d this was hard-coded to openrouter and
  // operators ended up with cross-provider slugs that 404'd at first
  // turn (anthropic/claude-haiku-4.5 vs the direct-Anthropic
  // claude-haiku-4-5).
  const [catalog, setCatalog] = useState<ExplorerModel[]>([]);
  const [catalogState, setCatalogState] = useState<{ loading: boolean; error: string | null }>({
    loading: true,
    error: null,
  });
  useEffect(() => {
    const provider = form.provider || 'openrouter';
    let cancelled = false;
    // Surface the loading state immediately so the dropdown shows a
    // spinner during the swap instead of a stale catalog from the
    // previous provider.
    setCatalogState({ loading: true, error: null });
    setCatalog([]);
    apiFetch<{ models?: ExplorerModel[]; error?: string }>(
      `/api/models?provider=${encodeURIComponent(provider)}`,
    )
      .then((d) => {
        if (cancelled) return;
        if (d?.models && Array.isArray(d.models)) {
          setCatalog(d.models as ExplorerModel[]);
          setCatalogState({ loading: false, error: d.error ?? null });
        } else {
          setCatalogState({ loading: false, error: d?.error ?? 'No catalog returned' });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalogState({
          loading: false,
          error: err instanceof Error ? err.message : 'Catalog fetch failed',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [form.provider]);

  // Backup-route model catalog — same shape as the primary above, keyed on
  // form.backupProvider so the backup's ModelSelect lists the right slugs.
  // Only fetched while the backup section is open (backupEnabled) to avoid a
  // wasted /api/models call on every agent that has no backup.
  const [backupCatalog, setBackupCatalog] = useState<ExplorerModel[]>([]);
  const [backupCatalogState, setBackupCatalogState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: true, error: null });
  useEffect(() => {
    if (!form.backupEnabled) return;
    const provider = form.backupProvider || 'openrouter';
    let cancelled = false;
    setBackupCatalogState({ loading: true, error: null });
    setBackupCatalog([]);
    apiFetch<{ models?: ExplorerModel[]; error?: string }>(
      `/api/models?provider=${encodeURIComponent(provider)}`,
    )
      .then((d) => {
        if (cancelled) return;
        if (d?.models && Array.isArray(d.models)) {
          setBackupCatalog(d.models as ExplorerModel[]);
          setBackupCatalogState({ loading: false, error: d.error ?? null });
        } else {
          setBackupCatalogState({ loading: false, error: d?.error ?? 'No catalog returned' });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBackupCatalogState({
          loading: false,
          error: err instanceof Error ? err.message : 'Catalog fetch failed',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [form.backupProvider, form.backupEnabled]);

  const openCreate = () => {
    setForm(emptyForm());
    setSlugTouched(false);
    setSection((s) => (s === 'learned' ? 'general' : s));
    setEditing({ mode: 'create' });
  };

  const openEdit = (agent: AgentSummary) => {
    setForm(formFromAgent(agent));
    setSlugTouched(true);
    setEditing({ mode: 'edit', agent });
  };

  const closeDialog = () => {
    setEditing(undefined);
  };

  // Deep link: /settings/agents?selected=<id-or-slug> opens that agent's
  // editor once the list arrives (agent_list hands these URLs to the
  // assistant). One-shot entry point — selection stays client-state after.
  const searchParams = useSearchParams();
  const router = useRouter();
  // Tab is URL-driven (`?tab=models`) per the settings convention, so the
  // Models matrix is linkable. Staged changes over there are memory-only —
  // switching tabs discards them by design.
  const tab = searchParams.get('tab') === 'models' ? 'models' : 'agents';
  // While the Models tab is mid-apply the switcher locks: unmounting it would
  // hide per-row progress and silently drop still-staged failures.
  const [modelsBusy, setModelsBusy] = useState(false);
  const onTabChange = (next: string) => {
    if (modelsBusy) return;
    router.replace(next === 'models' ? '/settings/agents?tab=models' : '/settings/agents', {
      scroll: false,
    });
  };
  const requestedAgentRef = useRef(searchParams.get('selected'));
  useEffect(() => {
    const want = requestedAgentRef.current?.trim();
    if (!want || agents.length === 0) return;
    requestedAgentRef.current = null;
    const hit = agents.find((a) => a.id === want || a.slug === want);
    if (hit) openEdit(hit);
  }, [agents]);

  // Clone: open the CREATE form pre-seeded from a donor row. The clone is
  // operator-authored, so the boot reconcile never touches it — the stable way
  // to build on a system agent's proven config (overriding a manifest agent
  // in place would be silently reverted by the next update's def sync). It
  // lands as role 'custom' and DISABLED: a second enabled responder would
  // enter priority resolution and could shadow the persona on Telegram/web —
  // promoting a clone is a deliberate act. Avatar resets so twins stay
  // tellable-apart; the slug regenerates from the editable name.
  const openClone = (donor: AgentSummary) => {
    const name = `${donor.name} copy`;
    setForm({
      ...formFromAgent(donor),
      name,
      slug: slugify(name, { maxLength: 64 }),
      role: 'custom',
      enabled: false,
      avatar: null,
    });
    setSlugTouched(false);
    setSection((s) => (s === 'learned' ? 'general' : s));
    setEditing({ mode: 'create' });
  };

  const onNameChange = (v: string) => {
    setForm((f) => ({
      ...f,
      name: v,
      slug: slugTouched ? f.slug : slugify(v, { maxLength: 64 }),
    }));
  };

  /** When the user picks a different role on a freshly-created agent, swap
   *  the default model + system prompt to match the new role — but only
   *  if the user hasn't customised them yet (best-effort heuristic). */
  const onRoleChange = (next: Role) => {
    setForm((f) => {
      const prevDefaults = defaultsForRole(f.role);
      const nextDefaults = defaultsForRole(next);
      const isUntouchedModel = f.model === prevDefaults.model;
      const isUntouchedPrompt =
        f.systemPrompt === prevDefaults.systemPrompt ||
        f.systemPrompt === DEFAULT_SYSTEM_PROMPT ||
        f.systemPrompt === DEFAULT_SUMMARIZER_PROMPT ||
        f.systemPrompt === DEFAULT_EXTRACTOR_PROMPT ||
        f.systemPrompt === DEFAULT_REFLECTOR_PROMPT;
      return {
        ...f,
        role: next,
        model: isUntouchedModel ? nextDefaults.model : f.model,
        systemPrompt: isUntouchedPrompt ? nextDefaults.systemPrompt : f.systemPrompt,
      };
    });
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;

    // The form is `noValidate` because its fields are spread across tabs and
    // inactive tabs are CSS-hidden: the browser aborts a native-validation
    // submit *silently* when the invalid field isn't focusable. Re-run the
    // same constraints by hand, jump to the tab holding the first invalid
    // field (form/DOM order), then let the native bubble show on it.
    const formEl = e.currentTarget as HTMLFormElement;
    if (!formEl.checkValidity()) {
      const bad = formEl.querySelector<HTMLInputElement>(
        'input:invalid, select:invalid, textarea:invalid',
      );
      const target = bad?.closest<HTMLElement>('[data-agent-section]')?.dataset.agentSection as
        AgentSection | undefined;
      if (target && target !== section) {
        // flushSync so the tab switch commits before reportValidity() —
        // a display:none field can't receive focus or show the bubble.
        flushSync(() => setSection(target));
      }
      bad?.reportValidity();
      return;
    }

    const memoryConfig: MemoryConfig = {};
    const limit = parseInt(form.historyLimit, 10);
    if (!Number.isNaN(limit)) memoryConfig.history_limit = limit;
    const win = form.historyWindowHours.trim();
    if (win) {
      const n = parseFloat(win);
      if (!Number.isNaN(n)) memoryConfig.history_window_hours = n;
    }
    if (form.role === 'responder' || form.role === 'assistant') {
      const dl = parseInt(form.digestLimit, 10);
      if (!Number.isNaN(dl)) memoryConfig.digest_limit = dl;
      const fl = parseInt(form.factLimit, 10);
      if (!Number.isNaN(fl)) memoryConfig.fact_limit = fl;
      const cl = parseInt(form.contentHitLimit, 10);
      if (!Number.isNaN(cl)) memoryConfig.content_hit_limit = cl;
    }
    if (form.role === 'summarizer') {
      const st = parseInt(form.summarizeThreshold, 10);
      if (!Number.isNaN(st)) memoryConfig.summarize_threshold = st;
      const sb = parseInt(form.summarizeBatch, 10);
      if (!Number.isNaN(sb)) memoryConfig.summarize_batch = sb;
    }
    if (form.role === 'extractor') {
      const types = form.extractTypes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      memoryConfig.extract_types = types.length > 0 ? types : ['note'];
      memoryConfig.extract_facts = form.extractFacts;
      const cap = form.extractCostCapCents.trim();
      if (cap === '') {
        memoryConfig.extract_cost_cap_micro_usd = null;
      } else {
        const cents = parseFloat(cap);
        if (!Number.isNaN(cents) && cents >= 0) {
          memoryConfig.extract_cost_cap_micro_usd = Math.round(cents * 10_000);
        }
      }
    }
    // Delegation allowlist. Always send it (even empty) so de-selecting every
    // delegate actually clears it — the server merges memory_config, so an
    // omitted key would otherwise be preserved.
    memoryConfig.delegate_to = form.delegateTo;

    // Tool-result spill thresholds (KB). Only set keys the operator filled;
    // blank = fall back to the env/global default. Always send the object
    // (possibly empty) so clearing a field actually clears it under the merge.
    const rh: { inline_max_kb?: number; embed_min_kb?: number; spill_max_kb?: number } = {};
    const inlineKb = parseInt(form.resultInlineMaxKb, 10);
    if (!Number.isNaN(inlineKb) && inlineKb > 0) rh.inline_max_kb = inlineKb;
    const embedKb = parseInt(form.resultEmbedMinKb, 10);
    if (!Number.isNaN(embedKb) && embedKb > 0) rh.embed_min_kb = embedKb;
    const spillKb = parseInt(form.resultSpillMaxKb, 10);
    if (!Number.isNaN(spillKb) && spillKb > 0) rh.spill_max_kb = spillKb;
    memoryConfig.result_handling = rh;

    const params: { temperature?: number; max_tokens?: number; suggest_follow_up?: boolean } = {};
    const t = parseFloat(form.temperature);
    if (!Number.isNaN(t)) params.temperature = t;
    const mt = form.maxTokens.trim();
    if (mt) {
      const n = parseInt(mt, 10);
      if (!Number.isNaN(n)) params.max_tokens = n;
    }
    // Only persisted when on; absent means off, keeping default rows clean.
    if (form.suggestFollowUp) params.suggest_follow_up = true;

    const priority = parseInt(form.priority, 10);

    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      role: form.role,
      provider: form.provider.trim() || 'openrouter',
      model: form.model.trim(),
      apiKeyId: form.apiKeyId || null,
      // Backup chat route. Always send all four so toggling failover off (or
      // clearing a field) actually persists — the PATCH set-map writes each
      // explicitly. backupEnabled gates failover at runtime, not the columns.
      backupEnabled: form.backupEnabled,
      backupProvider: form.backupProvider.trim() || null,
      backupModel: form.backupModel.trim() || null,
      backupApiKeyId: form.backupApiKeyId || null,
      // Per-route host + tailnet flag. Always send so clearing persists.
      baseUrl: form.baseUrl.trim() || null,
      viaTailnet: form.viaTailnet,
      backupBaseUrl: form.backupBaseUrl.trim() || null,
      backupViaTailnet: form.backupViaTailnet,
      // Per-agent voice: pinned TTS worker, or null to use the default.
      ttsWorkerId: form.ttsWorkerId || null,
      systemPrompt: form.systemPrompt,
      memoryConfig,
      params,
      priority: Number.isNaN(priority) ? 100 : priority,
      enabled: form.enabled,
      skillSlugs: form.skillSlugs,
      toolGroupSlugs: form.toolGroupSlugs,
      avatar: form.avatar,
      ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
    };

    const url = editing.mode === 'create' ? '/api/agents' : `/api/agents/${editing.agent.id}`;
    const method = editing.mode === 'create' ? 'POST' : 'PATCH';
    setSaving(true);
    try {
      // Both POST and PATCH return `{ agent: row }` (dates already ISO).
      const { agent: saved } = await apiSend<{ agent: AgentSummary }>(url, method, body);
      toast.success(editing.mode === 'create' ? 'Agent created' : 'Agent saved');
      // Keep focus on the just-saved row instead of dropping back to the
      // empty-detail state. Promote the saved record into `editing` (turning a
      // create into an edit naturally — slug/id are now known) and resync the
      // form fields to whatever the server canonicalised. invalidateAgentQueries
      // then refetches the list around the still-selected row.
      if (saved) {
        setEditing({ mode: 'edit', agent: saved });
        setForm(formFromAgent(saved));
        setSlugTouched(true);
      } else {
        closeDialog();
      }
      await invalidateAgentQueries(queryClient);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const a = deleteTarget;
    if (!a) return;
    try {
      await apiSend(`/api/agents/${a.id}`, 'DELETE');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
      return;
    }
    toast.success(`Deleted ${a.name}`);
    if (editing?.mode === 'edit' && editing.agent.id === a.id) closeDialog();
    await invalidateAgentQueries(queryClient);
  };

  const activeResponder = useMemo(
    () =>
      agents
        .filter((a) => a.enabled && a.role === 'responder')
        .sort((a, b) => b.priority - a.priority)[0],
    [agents],
  );
  const selectedId = editing?.mode === 'edit' ? editing.agent.id : null;
  const temp = Number.parseFloat(form.temperature) || 0;

  if (agentsQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (agentsQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {agentsQuery.error instanceof Error
            ? agentsQuery.error.message
            : 'Failed to load agents.'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => agentsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Agents (master-detail editor) | Models (bulk model matrix) */}
      <div className="shrink-0 border-b border-border px-4 py-2">
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value="agents" disabled={modelsBusy}>
              Agents
            </TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === 'models' ? (
        <ModelsTab agents={agents} apiKeys={apiKeys} onBusyChange={setModelsBusy} />
      ) : (
        <>
          {/* Active responder banner */}
          <div className="shrink-0 border-b border-border px-4 py-2 text-xs">
            {activeResponder ? (
              <p className="text-muted-foreground">
                Active Telegram responder:{' '}
                <strong className="text-foreground">{activeResponder.name}</strong> (
                {activeResponder.model}, priority {activeResponder.priority})
              </p>
            ) : (
              <p className="text-amber-700 dark:text-amber-300">
                No enabled <code>responder</code> agent — Telegram messages go unanswered until you
                create one.
              </p>
            )}
          </div>

          <div className="md:grid md:min-h-0 md:flex-1 md:grid-cols-[340px_1fr] md:overflow-hidden">
            {/* ── Left: agent list ─────────────────────────────────────── */}
            <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
              <div className="flex items-center justify-between gap-2 border-b border-border p-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Agents
                </h2>
                <Button type="button" size="sm" onClick={openCreate}>
                  <Plus /> New
                </Button>
              </div>
              <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
                {agents.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                    No agents yet. Click <strong>New</strong> to create one — you&apos;ll need an
                    API key saved at <code>/settings/keys</code> first.
                  </p>
                ) : (
                  agents.map((a) => {
                    const selected = selectedId === a.id;
                    return (
                      <ListCard
                        key={a.id}
                        onClick={() => openEdit(a)}
                        selected={selected}
                        dimmed={!a.enabled}
                      >
                        <div className="flex items-center gap-2.5">
                          {/* Every agent gets an avatar, stored record or not:
                              the STYLE is the brain's, so all a per-agent record
                              adds is a rerolled seed. Falling back to the slug
                              means a fresh brain looks right immediately, rather
                              than showing initials until each agent is opened and
                              saved one by one. */}
                          <GeneratedAvatar seed={a.avatar?.seed || a.slug} size={32} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{a.name}</span>
                              {!a.enabled && (
                                <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                                  off
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                                {a.role}
                              </span>
                              <span className="shrink-0 text-[11px]">
                                {getProvider(a.provider)?.label ?? a.provider}
                              </span>
                              <span className="shrink-0 text-[11px]" aria-hidden>
                                ·
                              </span>
                              <code className="truncate font-mono text-[11px]">{a.model}</code>
                            </div>
                          </div>
                        </div>
                      </ListCard>
                    );
                  })
                )}
              </div>
            </div>

            {/* ── Right: editor ────────────────────────────────────────── */}
            {/* `relative` makes this pane the containing block for the form's
            absolutely-positioned descendants — notably the Radix Switch/Checkbox
            hidden "bubble inputs" on the many tool/skill toggles. Without it
            their offsetParent resolves to the fixed `<main>`, so they escape this
            pane's overflow-y-auto clip and inflate main's scroll area → a second
            scrollbar alongside this one. Keeping them contained leaves a single
            scroller (this pane). */}
            <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
              {!editing ? (
                <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
                  Select an agent to edit, or create a new one.
                </div>
              ) : (
                <div className="space-y-4 p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold">
                        {editing.mode === 'create' ? 'New agent' : `Edit ${editing.agent.name}`}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {editing.mode === 'create'
                          ? 'A new AI agent. Pick a stored API key, model, and persona.'
                          : 'Update the agent. Slug is immutable.'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <Switch
                          checked={form.enabled}
                          onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                        />
                        Enabled
                      </label>
                      {editing.mode === 'edit' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => openClone(editing.agent)}
                        >
                          <Copy /> Duplicate
                        </Button>
                      )}
                      {editing.mode === 'edit' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive-ink hover:text-destructive-ink"
                          onClick={() => setDeleteTarget(editing.agent)}
                        >
                          <Trash2 /> Delete
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* Sub-tabs of the editor. `TabsContent` is `forceMount` +
                  CSS-hidden so (a) all fields stay in the DOM for
                  checkValidity() across tabs and (b) self-persisting children
                  (TelegramBotSection, PersonaNotesEditor) keep their local
                  state across tab switches. */}
                  <Tabs value={section} onValueChange={(v) => setSection(v as AgentSection)}>
                    <TabsList className="h-auto flex-wrap justify-start">
                      <TabsTrigger value="general">General</TabsTrigger>
                      <TabsTrigger value="model">Model & routing</TabsTrigger>
                      <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
                      <TabsTrigger value="memory">Memory</TabsTrigger>
                      {editing.mode === 'edit' && (
                        <TabsTrigger value="learned">Learned</TabsTrigger>
                      )}
                    </TabsList>
                    {/* noValidate: see submitForm — the browser can't focus an
                    invalid field on a hidden tab, so constraints are re-run
                    there with a jump to the offending tab. */}
                    <form onSubmit={submitForm} noValidate className="mt-4 space-y-4">
                      <TabsContent
                        forceMount
                        value="general"
                        data-agent-section="general"
                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                      >
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="name">Name</Label>
                            <Input
                              id="name"
                              value={form.name}
                              onChange={(e) => onNameChange(e.target.value)}
                              placeholder="Telegram responder"
                              required
                              autoFocus
                              aria-describedby={hintId('name')}
                            />
                            <FieldHint id="name">
                              What you&apos;ll see in the agent list and above this agent&apos;s
                              messages.
                            </FieldHint>
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="slug">Slug</Label>
                            <Input
                              id="slug"
                              value={form.slug}
                              onChange={(e) => {
                                setSlugTouched(true);
                                setForm((f) => ({ ...f, slug: e.target.value }));
                              }}
                              pattern="[a-z0-9_\-]+"
                              required
                              disabled={editing?.mode === 'edit'}
                              aria-describedby={hintId('slug')}
                            />
                            <FieldHint id="slug">
                              The stable id other agents delegate to. Fixed once saved.
                            </FieldHint>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="description">Description</Label>
                          <Input
                            id="description"
                            value={form.description}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, description: e.target.value }))
                            }
                            placeholder="Default Telegram responder, with memory"
                            aria-describedby={hintId('description')}
                          />
                          <FieldHint id="description">
                            One line on what this agent is for — it&apos;s what another agent reads
                            when choosing whether to hand work over.
                          </FieldHint>
                        </div>

                        <div className="space-y-1.5">
                          <Label>Avatar</Label>
                          <AvatarPicker
                            value={form.avatar}
                            onChange={(v) =>
                              // The stored shape still carries a style for API
                              // compatibility, but rendering ignores it — the
                              // brain's style (Appearance) is what every avatar
                              // is drawn in. Stamp the current one so the row
                              // stays coherent rather than storing a stale id.
                              setForm((f) => ({
                                ...f,
                                avatar: v ? { style: avatarStyle, seed: v.seed } : null,
                              }))
                            }
                            fallbackSeed={form.slug || form.name || 'agent'}
                            clearLabel="Reset to default"
                          />
                          <FieldHint>
                            Shown beside this agent&apos;s replies and in the list, drawn in the
                            brain&apos;s avatar style (change that in Appearance). Every agent has
                            one already, seeded from its slug — Randomize just picks a different
                            one.
                          </FieldHint>
                        </div>

                        {/*
              Two rows of paired fields. Row 1: Role + Priority (short
              controls, fit naturally side-by-side). Row 2: Model + API key
              50/50 — the model combobox needs the extra width so its
              selected-summary (name + context + pricing badges) doesn't
              get truncated on long Anthropic/Google slugs.
            */}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="role">Role</Label>
                            <select
                              id="role"
                              value={form.role}
                              onChange={(e) => onRoleChange(e.target.value as Role)}
                              className={SELECT_CLASS}
                              aria-describedby={hintId('role')}
                            >
                              {ROLES.map((r) => (
                                <option key={r.value} value={r.value}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                            <FieldHint id="role">
                              Which loop runs this agent. It also decides which of the tuning fields
                              below apply.
                            </FieldHint>
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="priority">Priority</Label>
                            <Input
                              id="priority"
                              type="number"
                              value={form.priority}
                              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                              min={0}
                              step={1}
                              aria-describedby={hintId('priority')}
                            />
                            <FieldHint id="priority">
                              Ordering when several agents qualify — highest sits at the top of the
                              chat list.
                            </FieldHint>
                          </div>
                        </div>

                        {form.role === 'responder' && (
                          <fieldset className="space-y-3 rounded-md border border-border p-3">
                            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Telegram bot
                            </legend>
                            {editing.mode === 'edit' ? (
                              <TelegramBotSection agentId={editing.agent.id} />
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Save this responder first, then link its Telegram bot here.
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              This responder long-polls its own bot. Create one with{' '}
                              <a
                                href="https://t.me/BotFather"
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                @BotFather
                              </a>{' '}
                              and paste the token — it&apos;s encrypted at rest. DMs to this bot are
                              answered by this agent.
                            </p>
                          </fieldset>
                        )}
                      </TabsContent>

                      <TabsContent
                        forceMount
                        value="model"
                        data-agent-section="model"
                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                      >
                        {/* Provider + key side by side; the model picker gets its own
                full-width row below (three dropdowns abreast was too
                cramped). Post-Phase-3 the provider field on the agent row
                actually controls runtime dispatch —
                `getChatAdapter(agent.provider)` resolves the adapter the
                responder / assistant / heartbeat loop runs through, and
                the API key filter narrows accordingly. */}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="provider">Provider</Label>
                            {(() => {
                              const chatProviders = providersForCapability('chat');
                              return (
                                <>
                                  <select
                                    id="provider"
                                    value={form.provider}
                                    onChange={(e) =>
                                      setForm((f) => ({ ...f, provider: e.target.value }))
                                    }
                                    className={SELECT_CLASS}
                                    required
                                  >
                                    {chatProviders.map((p) => {
                                      const wired = isProviderWired(p.id, 'chat');
                                      return (
                                        <option key={p.id} value={p.id}>
                                          {p.label}
                                          {wired ? '' : ' · not yet wired'}
                                        </option>
                                      );
                                    })}
                                  </select>
                                  <FieldHint id="provider">
                                    Which service runs this agent&apos;s turns. It picks the adapter
                                    and narrows the key and model lists below.
                                  </FieldHint>
                                  {!isProviderWired(form.provider, 'chat') && (
                                    <p className="text-xs text-amber-600 dark:text-amber-400">
                                      No chat adapter registered for <code>{form.provider}</code>.
                                      Saves will succeed but the responder/assistant will fail at
                                      first turn until a chat adapter ships for this provider.
                                    </p>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="apiKey">API key</Label>
                            {(() => {
                              // Filter keys to those whose service matches the selected
                              // provider. Direct-provider workers need a same-provider
                              // key; OR workers need an `openrouter` key. The runtime
                              // refuses cross-provider keys via getApiKeyById +
                              // adapter.chat()'s auth check.
                              const eligibleAgentKeys = apiKeys.filter(
                                (k) => k.service === form.provider,
                              );
                              return (
                                <>
                                  <select
                                    id="apiKey"
                                    value={form.apiKeyId}
                                    onChange={(e) =>
                                      setForm((f) => ({ ...f, apiKeyId: e.target.value }))
                                    }
                                    className={SELECT_CLASS}
                                    required
                                  >
                                    <option value="">— select a key —</option>
                                    {eligibleAgentKeys.map((k) => (
                                      <option key={k.id} value={k.id}>
                                        {k.service} / {k.label} ({k.masked})
                                      </option>
                                    ))}
                                  </select>
                                  {apiKeys.length > 0 && eligibleAgentKeys.length === 0 && (
                                    <p className="text-xs text-amber-600 dark:text-amber-400">
                                      None of your saved keys are for <code>{form.provider}</code>.
                                      Add one at{' '}
                                      <a href="/settings/keys" className="underline">
                                        /settings/keys
                                      </a>{' '}
                                      or pick a different provider.
                                    </p>
                                  )}
                                  {apiKeys.length === 0 ? (
                                    <FieldHint>
                                      No keys saved.{' '}
                                      <a href="/settings/keys" className="underline">
                                        Add one
                                      </a>{' '}
                                      first.
                                    </FieldHint>
                                  ) : (
                                    <FieldHint id="apiKey">
                                      Which saved key pays for this agent. It must belong to the
                                      provider above — the runtime refuses a mismatch.
                                    </FieldHint>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="model">Model</Label>
                          <ModelSelect
                            id="model"
                            value={form.model}
                            onValueChange={(next) => setForm((f) => ({ ...f, model: next }))}
                            models={catalog}
                            loading={catalogState.loading}
                            error={catalogState.error}
                            placeholder="— pick a model —"
                            emptyMessage="No matching models in the catalog."
                            required
                          />
                          <ContextWindowHint model={form.model} limits={contextLimits} />
                          {editing.mode === 'edit' && editing.agent.manifestManaged && (
                            <p className="text-xs text-muted-foreground">
                              System agent — your provider, model and prompt choices are permanent
                              across upgrades; only tuning params re-sync to the system default.
                              Studio&apos;s reset-to-default pulls the shipped configuration back if
                              you want it.
                            </p>
                          )}
                          {(() => {
                            // Subtle hint when the typed slug doesn't appear in the
                            // current provider's catalog AND discovery has settled.
                            // Catches the "switched provider mid-edit and forgot the
                            // slug shape differs" case (OR's `anthropic/claude-haiku-
                            // 4.5` vs direct Anthropic's `claude-haiku-4-5`). Custom
                            // slugs are still allowed — the save commits whatever's
                            // typed — so this is informational, not blocking.
                            if (catalogState.loading) return null;
                            if (!form.model.trim()) return null;
                            if (catalog.some((m) => m.id === form.model)) return null;
                            return (
                              <p className="text-xs text-amber-600 dark:text-amber-400">
                                <code>{form.model}</code> isn&apos;t in <code>{form.provider}</code>
                                &apos;s catalog. Save will succeed but the call will fail if the
                                slug is wrong — direct providers use bare ids (e.g.{' '}
                                <code>claude-haiku-4-5</code>) where OpenRouter uses prefixed slugs
                                (e.g. <code>anthropic/claude-haiku-4.5</code>
                                ).
                              </p>
                            );
                          })()}
                        </div>

                        {/* Per-agent voice (migration 0066). The chosen TTS worker owns
                provider + voice + model + key; the agent only references it.
                "Default" = the owner's default TTS worker, resolved at speak
                time (so it tracks whatever you mark default in AI workers). */}
                        <div className="space-y-1.5">
                          <Label htmlFor="ttsWorker">Voice (TTS)</Label>
                          <select
                            id="ttsWorker"
                            value={form.ttsWorkerId}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, ttsWorkerId: e.target.value }))
                            }
                            className={SELECT_CLASS}
                          >
                            {(() => {
                              const def =
                                ttsWorkers.find((w) => w.enabled && w.isDefault) ??
                                ttsWorkers.find((w) => w.enabled);
                              return (
                                <option value="">
                                  {def ? `Default voice (${def.name})` : 'Default voice'}
                                </option>
                              );
                            })()}
                            {ttsWorkers.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name} — {w.provider}/{w.model}
                                {w.enabled ? '' : ' (disabled)'}
                              </option>
                            ))}
                          </select>
                          {ttsWorkers.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No voice (TTS) workers yet — replies use the default voice. Add one at{' '}
                              <a href="/settings/ai-workers" className="underline">
                                /settings/ai-workers
                              </a>
                              .
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Which voice this agent speaks with. Leave on <em>Default</em> to track
                              the default TTS worker; manage voices at{' '}
                              <a href="/settings/ai-workers" className="underline">
                                /settings/ai-workers
                              </a>
                              .
                            </p>
                          )}
                        </div>

                        {/* Primary route host (migration 0063). The `local` adapter (self-
                hosted/LAN/tailnet box) and the `custom` adapter (cloud OpenAI-
                compatible endpoint) both need a per-route Base URL. */}
                        {(form.provider === 'local' || form.provider === 'custom') && (
                          <RouteHostFields
                            idPrefix="primary"
                            provider={form.provider}
                            baseUrl={form.baseUrl}
                            viaTailnet={form.viaTailnet}
                            peers={tailnetPeers}
                            onBaseUrl={(v) => setForm((f) => ({ ...f, baseUrl: v }))}
                            onViaTailnet={(v) => setForm((f) => ({ ...f, viaTailnet: v }))}
                          />
                        )}

                        <BackupRouteSection
                          form={form}
                          setForm={setForm}
                          apiKeys={apiKeys}
                          tailnetPeers={tailnetPeers}
                          catalog={backupCatalog}
                          catalogState={backupCatalogState}
                        />

                        <fieldset className="space-y-3 rounded-md border border-border p-3">
                          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Model params
                          </legend>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                              <div className="flex items-baseline justify-between gap-2">
                                <Label>Temperature</Label>
                                <span className="text-xs">
                                  <span className="font-medium text-foreground">
                                    {tempDescriptor(temp).word}
                                  </span>
                                  <span className="ml-1.5 tabular-nums text-muted-foreground">
                                    {temp.toFixed(1)}
                                  </span>
                                </span>
                              </div>
                              <Slider
                                min={0}
                                max={2}
                                step={0.1}
                                value={[temp]}
                                onValueChange={([v]) =>
                                  setForm((f) => ({ ...f, temperature: String(v ?? 0) }))
                                }
                                className="py-1.5"
                                aria-label="Temperature"
                              />
                              <FieldHint
                                warn={
                                  temp > 1.2 ? 'This high, replies start to wander.' : undefined
                                }
                              >
                                {tempDescriptor(temp).hint}
                              </FieldHint>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="maxTokens">Max tokens</Label>
                              <Input
                                id="maxTokens"
                                type="number"
                                step={1}
                                min={1}
                                value={form.maxTokens}
                                onChange={(e) =>
                                  setForm((f) => ({ ...f, maxTokens: e.target.value }))
                                }
                                placeholder="(provider default)"
                                aria-describedby={hintId('maxTokens')}
                              />
                              <FieldHint
                                id="maxTokens"
                                warn="Set it too low and long answers get cut off mid-sentence."
                              >
                                Ceiling on a single reply. Blank leaves it to the provider.
                              </FieldHint>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <label className="flex cursor-pointer items-center gap-2 text-sm">
                              <Switch
                                checked={form.suggestFollowUp}
                                onCheckedChange={(v) =>
                                  setForm((f) => ({ ...f, suggestFollowUp: v }))
                                }
                              />
                              Suggest follow-ups
                            </label>
                            <FieldHint>
                              After each reply, propose the next question as an accept-with-Enter
                              chip in the chat composer. Runs the Follow-up suggester worker once
                              per turn (a cheap model, off the reply&apos;s critical path), so it
                              costs a little per message. Off by default.
                            </FieldHint>
                          </div>
                        </fieldset>

                        {editing.mode === 'edit' && (
                          <section className="space-y-2 border-t border-border pt-6">
                            <h3 className="text-sm font-semibold">Test chat</h3>
                            <p className="text-xs text-muted-foreground">
                              Send a one-shot prompt through this agent&apos;s adapter (
                              <code>{editing.agent.provider}</code>) and see what comes back. Uses
                              the saved system prompt, model, and params — same path as the
                              production responder. Useful for validating a new direct- provider key
                              (Anthropic / Google / xAI) without sending a real Telegram message.
                            </p>
                            <ChatTestButton
                              endpoint={`/api/agents/${editing.agent.id}/test/chat`}
                            />
                          </section>
                        )}
                      </TabsContent>

                      <TabsContent
                        forceMount
                        value="memory"
                        data-agent-section="memory"
                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                      >
                        <MemorySection form={form} setForm={setForm} />
                      </TabsContent>

                      <TabsContent
                        forceMount
                        value="behaviour"
                        data-agent-section="behaviour"
                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                      >
                        <div className="space-y-1.5">
                          <Label htmlFor="systemPrompt">System prompt</Label>
                          <textarea
                            id="systemPrompt"
                            value={form.systemPrompt}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, systemPrompt: e.target.value }))
                            }
                            rows={6}
                            required
                            className={TEXTAREA_CLASS}
                          />
                          <p className="text-xs text-muted-foreground">
                            For <code>anthropic/*</code> models this block is sent with{' '}
                            <code>cache_control</code>, so the prefix is reused turn-to-turn and the
                            provider only re-processes the new user message.
                          </p>
                        </div>

                        <fieldset className="space-y-3 rounded-md border border-border p-3">
                          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Tool groups
                          </legend>
                          {availableToolGroups.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No tool groups yet. Create capability bundles at{' '}
                              <a href="/settings/tool-groups" className="underline">
                                /settings/tool-groups
                              </a>
                              .
                            </p>
                          ) : (
                            <ToolGroupPicker
                              available={availableToolGroups}
                              selected={form.toolGroupSlugs}
                              onChange={(next) => setForm((f) => ({ ...f, toolGroupSlugs: next }))}
                            />
                          )}
                          <p className="text-xs text-muted-foreground">
                            The primary way to grant capability — each group joins all its tools
                            into the agent&apos;s effective set. Curate bundles at{' '}
                            <a href="/settings/tool-groups" className="underline">
                              /settings/tool-groups
                            </a>
                            .
                          </p>
                          {/* Effective set — what the runtime actually resolves (the union of
                  the granted groups' tools; P6 — groups are the sole grant). */}
                          <div className="rounded-md bg-muted/40 p-2">
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Effective tools · {effectiveTools.length}
                            </p>
                            {effectiveTools.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                None — the agent never sees a <code>tools</code> parameter.
                              </p>
                            ) : (
                              <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                                {effectiveTools.join(', ')}
                              </p>
                            )}
                          </div>
                        </fieldset>

                        <fieldset className="space-y-3 rounded-md border border-border p-3">
                          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Skills
                          </legend>
                          {availableSkills.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No skills yet. Author one at{' '}
                              <a href="/settings/skills" className="underline">
                                /settings/skills
                              </a>
                              .
                            </p>
                          ) : (
                            <SkillPicker
                              available={availableSkills}
                              selected={form.skillSlugs}
                              onChange={(next) => setForm((f) => ({ ...f, skillSlugs: next }))}
                            />
                          )}
                          <p className="text-xs text-muted-foreground">
                            Each attached skill appends its instructions to the agent&apos;s system
                            prompt (always-loaded). Skills are pure teaching — capability comes from
                            tool groups + direct grants above.
                          </p>
                        </fieldset>

                        <fieldset className="space-y-3 rounded-md border border-border p-3">
                          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Delegates to
                          </legend>
                          {agents.filter((a) => a.slug !== form.slug).length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No other agents to delegate to. Create another agent (e.g. a research
                              or recall agent) first.
                            </p>
                          ) : (
                            <DelegatePicker
                              available={agents
                                .filter((a) => a.slug !== form.slug)
                                .map((a) => ({ slug: a.slug, name: a.name, enabled: a.enabled }))}
                              selected={form.delegateTo}
                              onChange={(next) => setForm((f) => ({ ...f, delegateTo: next }))}
                            />
                          )}
                          <p className="text-xs text-muted-foreground">
                            Agents this one may hand a sub-task to via the <code>invoke_agent</code>{' '}
                            tool. Empty = delegation disabled (the runtime fails closed).
                            {form.delegateTo.length > 0 &&
                              !effectiveTools.includes('invoke_agent') && (
                                <span className="mt-1 block text-amber-600 dark:text-amber-400">
                                  Grant the <code>delegation</code> group (or{' '}
                                  <code>invoke_agent</code> directly), or these delegates can&apos;t
                                  actually be reached.
                                </span>
                              )}
                          </p>
                        </fieldset>

                        <fieldset className="space-y-3 rounded-md border border-border p-3">
                          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Tool results
                          </legend>
                          <p className="text-xs text-muted-foreground">
                            Large tool outputs (a delegated agent&apos;s full answer, a big file
                            read, a wide search) are stored and handed to the agent as a handle it
                            reads via <code>read_result</code> (page / grep / semantic query) —
                            instead of being truncated. Tune when that spill kicks in. Blank =
                            system default.
                          </p>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label htmlFor="result-inline">Inline max (KB)</Label>
                              <Input
                                id="result-inline"
                                type="number"
                                min={1}
                                value={form.resultInlineMaxKb}
                                onChange={(e) =>
                                  setForm((f) => ({ ...f, resultInlineMaxKb: e.target.value }))
                                }
                                placeholder="32 (default)"
                                aria-describedby={hintId('result-inline')}
                              />
                              <FieldHint
                                id="result-inline"
                                warn="Raise it and big results land straight in the prompt."
                              >
                                Results larger than this spill to the store.
                              </FieldHint>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="result-embed">Semantic-tier (KB)</Label>
                              <Input
                                id="result-embed"
                                type="number"
                                min={1}
                                value={form.resultEmbedMinKb}
                                onChange={(e) =>
                                  setForm((f) => ({ ...f, resultEmbedMinKb: e.target.value }))
                                }
                                placeholder="100 (default)"
                                aria-describedby={hintId('result-embed')}
                              />
                              <FieldHint id="result-embed">
                                At/over this, the agent is steered to semantic <code>query</code>.
                              </FieldHint>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="result-spill">Hard ceiling (KB)</Label>
                              <Input
                                id="result-spill"
                                type="number"
                                min={1}
                                value={form.resultSpillMaxKb}
                                onChange={(e) =>
                                  setForm((f) => ({ ...f, resultSpillMaxKb: e.target.value }))
                                }
                                placeholder="1024 (default)"
                                aria-describedby={hintId('result-spill')}
                              />
                              <FieldHint
                                id="result-spill"
                                warn="Raising it grows both the DB and the embedding bill."
                              >
                                Bigger results are head-truncated before storing.
                              </FieldHint>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Max embedding chunks and retention (TTL) are system-wide — set via{' '}
                            <code>TOOL_RESULT_MAX_CHUNKS</code> / <code>TOOL_RESULT_TTL_DAYS</code>{' '}
                            env vars.
                          </p>
                        </fieldset>
                      </TabsContent>

                      {editing.mode === 'edit' && (
                        <TabsContent
                          forceMount
                          value="learned"
                          data-agent-section="learned"
                          className="mt-0 space-y-4 data-[state=inactive]:hidden"
                        >
                          <PersonaNotesEditor
                            key={editing.agent.id}
                            agentId={editing.agent.id}
                            initialNotes={editing.agent.personaNotes}
                          />
                        </TabsContent>
                      )}

                      <div className="flex justify-end gap-2 border-t border-border pt-3">
                        <Button type="button" variant="outline" onClick={closeDialog}>
                          Cancel
                        </Button>
                        <SubmitButton pending={saving}>
                          {editing.mode === 'create' ? 'Create agent' : 'Save agent'}
                        </SubmitButton>
                      </div>
                    </form>
                  </Tabs>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Multi-select chip picker for tools. Each chip carries the slug; click
 * to toggle. Tools marked `requiresConfirm` get a small badge so the
 * operator can see at a glance which ones will (eventually) pause for
 * approval. Hovering shows the description.
 */
/**
 * Skill multi-select — one row per skill (name + description + Switch), with a
 * count of the tools each skill folds into the agent's allowlist.
 */
function SkillPicker({
  available,
  selected,
  onChange,
}: {
  available: SkillOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const items: ToggleListItem[] = available.map((s) => ({
    value: s.slug,
    label: s.name,
    description: s.description,
  }));
  return (
    <ToggleList items={items} selected={selected} onChange={onChange} collapsible searchable />
  );
}

/**
 * Tool-group multi-select — the PRIMARY capability control. One row per group
 * (name + description + member-tool count). Granting a group joins all its tools
 * into the agent's effective set at runtime.
 */
function ToolGroupPicker({
  available,
  selected,
  onChange,
}: {
  available: ToolGroupOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const items: ToggleListItem[] = available.map((g) => ({
    value: g.slug,
    label: g.name,
    description: g.description,
    meta: (
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {g.toolSlugs.length} tool{g.toolSlugs.length === 1 ? '' : 's'}
      </span>
    ),
  }));
  return (
    <ToggleList items={items} selected={selected} onChange={onChange} collapsible searchable />
  );
}

/**
 * Delegation multi-select. Chips are the OTHER agents' slugs; selecting one
 * adds it to this agent's memory_config.delegate_to allowlist, so it can be
 * reached via the invoke_agent tool. Disabled agents stay selectable but are
 * marked — invoke_agent only resolves enabled targets, so they won't work
 * until re-enabled.
 */
function DelegatePicker({
  available,
  selected,
  onChange,
}: {
  available: { slug: string; name: string; enabled: boolean }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const items: ToggleListItem[] = available.map((a) => ({
    value: a.slug,
    label: a.name,
    description: a.enabled ? undefined : 'Disabled — won’t resolve until re-enabled',
    meta: (
      <>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
          {a.slug}
        </code>
        {!a.enabled && (
          <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            off
          </span>
        )}
      </>
    ),
  }));
  return (
    <ToggleList items={items} selected={selected} onChange={onChange} collapsible searchable />
  );
}

/**
 * Readout under the Model field showing the resolved context window for the
 * typed slug, from the live OpenRouter map (static fallback) fetched by the
 * form. Renders nothing until a model is entered; says so plainly when a
 * slug isn't in the catalog (usually a typo in the id).
 */
function ContextWindowHint({ model, limits }: { model: string; limits: Record<string, number> }) {
  const slug = model.trim().toLowerCase();
  if (!slug) return null;
  const limit = limits[slug];
  if (!limit) {
    return (
      <p className="text-xs text-muted-foreground">
        Context window:{' '}
        <span className="text-amber-600 dark:text-amber-400">unknown for this slug</span> — check
        the exact id at openrouter.ai/models.
      </p>
    );
  }
  const pretty =
    limit >= 1_000_000
      ? `${(limit / 1_000_000).toFixed(limit % 1_000_000 === 0 ? 0 : 1)}M`
      : limit >= 1_000
        ? `${Math.round(limit / 1_000)}k`
        : `${limit}`;
  return (
    <p className="text-xs text-muted-foreground">
      Context window: <span className="font-medium text-foreground tabular-nums">{pretty}</span>{' '}
      tokens ({limit.toLocaleString()})
    </p>
  );
}
