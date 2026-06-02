'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Loader2, Plus, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModelSelect } from '@/components/ui/model-select';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { ExplorerModel } from '@/lib/model-explorer';
import {
  SUPPORTED_PROVIDERS,
  getProvider,
  isProviderWired,
  providersForCapability,
} from '@mantle/voice/client';
import type { AgentAvatar, PersonaNote } from '@mantle/db';
import { AvatarPicker } from '@/components/avatar-picker';
import { SubmitButton } from '@/components/ui/submit-button';
import { ToggleList, type ToggleListItem } from '@/components/toggle-list';
import { ToolPicker, type ToolOption } from '@/components/tool-picker';
import type { AgentTelegramBinding, AgentTelegramChat } from '@/lib/agent-telegram';
import { BoringAvatar } from '@/components/boring-avatar';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { PersonaNotesEditor } from './persona-notes-editor';
import { AgentChatTestButton } from './chat-test-button';

/** Built-in node types the extractor can be allow-listed against. Matches
 *  the `node_type` enum in packages/db/src/schema/nodes.ts minus `branch`
 *  (folders, never extracted). `secret` is included but uses metadata-only
 *  extraction — see `apps/agent/src/extractor.ts:readNodeBodyRaw`. */
const KNOWN_NODE_TYPES = [
  'note',
  'file',
  'email',
  'email_thread',
  'secret',
  'task',
  'event',
  'telegram_message',
] as const;
// `sermon`, `contact`, `printer_project` remain in the Postgres
// `node_type` enum but have no writer code. Hidden from the chip picker
// so the UI doesn't suggest types that produce no nodes. Re-add here
// (and a matching `case` in extractor.ts:readNodeBodyRaw) if a surface
// for one of them is ever built.

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
  { value: 'custom', label: 'Custom' },
] as const;

type Role = (typeof ROLES)[number]['value'];

type MemoryConfig = {
  history_limit?: number;
  history_window_hours?: number | null;
  digest_limit?: number;
  fact_limit?: number;
  content_hit_limit?: number;
  summarize_threshold?: number;
  summarize_batch?: number;
  extract_types?: string[];
  extract_facts?: boolean;
  extract_cost_cap_micro_usd?: number | null;
  /** Agent slugs this agent may delegate to via invoke_agent. */
  delegate_to?: string[];
  /** Tool-result spill thresholds (KB). Empty = env/global defaults. */
  result_handling?: { inline_max_kb?: number; embed_min_kb?: number; spill_max_kb?: number };
};

type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: Role;
  /** Provider id (see packages/voice/src/providers.ts). 'openrouter'
   *  for legacy rows pre-migration 0048. */
  provider: string;
  model: string;
  apiKeyId: string | null;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  backupEnabled: boolean;
  baseUrl: string | null;
  viaTailnet: boolean;
  backupBaseUrl: string | null;
  backupViaTailnet: boolean;
  systemPrompt: string;
  tools: string[];
  toolSlugs: string[];
  skillSlugs: string[];
  memoryConfig: MemoryConfig;
  params: { temperature?: number; max_tokens?: number; top_p?: number };
  avatar: AgentAvatar | null;
  personaNotes: PersonaNote[];
  priority: number;
  enabled: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

type ApiKeyOption = { id: string; service: string; label: string; masked: string };

export type SkillOption = {
  slug: string;
  name: string;
  description: string;
  toolSlugs: string[];
};

const DEFAULT_SYSTEM_PROMPT = `You are an assistant helping the user via Telegram. You have memory of the recent conversation in this chat. Be concise and conversational — short paragraphs, no headers, no bullet lists unless explicitly useful. Match the tone of the incoming message. Skip pleasantries unless they fit naturally. If you don't know something or can't help, say so plainly.`;

const DEFAULT_SUMMARIZER_PROMPT = `You are a memory compressor for an ongoing Telegram conversation. You will be given a chronological transcript of a chat between the user and an AI assistant, with each line prefixed by its 1-indexed turn number.

Group the transcript into TOPICS — contiguous stretches of turns about a single subject. A short batch is often one topic; a longer batch may contain several. Don't force splits.

For each topic, produce:
  - A short label (2-5 words, title case)
  - A factual summary (3-6 sentences, no headers, no bullet lists) capturing decisions, commitments, specific facts about people/places/dates/numbers
  - The turn numbers belonging to this topic (contiguous range; topics don't overlap)

Be specific — write "Jason is preaching on Romans 8 this Sunday" not "they discussed church plans."

Output STRICT JSON:

{ "topics": [ { "label": "...", "summary": "...", "turn_indexes": [1, 2, 3] } ] }

Every turn number must appear exactly once across all topics combined.`;

const DEFAULT_EXTRACTOR_PROMPT = `You are a memory extractor for a personal AI assistant. You will be given the title and body of a piece of content (a note, document, email, etc.) belonging to a single user. Your job is to produce THREE outputs:

1. A 1-2 sentence summary of what this content is about. Be specific — names, dates, projects, numbers. Avoid filler.

2. A list of facts about the user or their world that this content reveals. Each fact is a single declarative sentence with the entities mentioned (people, projects, places, organisations, events) for cross-referencing.

3. A list of relations: direct relationships BETWEEN two named entities the content establishes (Sarah works_at Lister, Don father_of Jason). These build the user's knowledge graph.

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
- Be specific — "Jason prefers terse, no-bullet replies" beats "user likes brevity".
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
    model: 'anthropic/claude-sonnet-4.6',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    historyLimit: '20',
    digestLimit: '3',
    summarizeThreshold: '30',
    summarizeBatch: '20',
    extractTypes: '',
    factLimit: '10',
    contentHitLimit: '3',
  };
}

type FormState = {
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
  /** Slugs this agent may call during a turn. */
  toolSlugs: string[];
  skillSlugs: string[];
  /** Agent slugs this agent may delegate to via invoke_agent. */
  delegateTo: string[];
  /** Tool-result spill thresholds (KB, as strings). Empty = global default. */
  resultInlineMaxKb: string;
  resultEmbedMinKb: string;
  resultSpillMaxKb: string;
  temperature: string;
  maxTokens: string;
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
    toolSlugs: [],
    skillSlugs: [],
    delegateTo: [],
    resultInlineMaxKb: '',
    resultEmbedMinKb: '',
    resultSpillMaxKb: '',
    temperature: '0.7',
    maxTokens: '',
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
    toolSlugs: a.toolSlugs ?? [],
    skillSlugs: a.skillSlugs ?? [],
    delegateTo: a.memoryConfig.delegate_to ?? [],
    resultInlineMaxKb: a.memoryConfig.result_handling?.inline_max_kb?.toString() ?? '',
    resultEmbedMinKb: a.memoryConfig.result_handling?.embed_min_kb?.toString() ?? '',
    resultSpillMaxKb: a.memoryConfig.result_handling?.spill_max_kb?.toString() ?? '',
    temperature: a.params.temperature?.toString() ?? '0.7',
    maxTokens: a.params.max_tokens?.toString() ?? '',
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export function AgentsClient({
  initialAgents,
  apiKeys,
  availableTools,
  availableSkills,
  tailnetPeers = [],
}: {
  initialAgents: AgentSummary[];
  apiKeys: ApiKeyOption[];
  availableTools: ToolOption[];
  availableSkills: SkillOption[];
  /** MagicDNS names of online tailnet peers — backs the base-URL datalist when
   *  a tailnet is up. Empty otherwise (input stays free-text). */
  tailnetPeers?: string[];
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[]>(initialAgents);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);

  // After a create/edit, we call router.refresh() to re-run the server
  // component; this hook propagates the new list into our local state.
  // (useState's initialValue is only read on first mount.)
  useEffect(() => {
    setAgents(initialAgents);
  }, [initialAgents]);

  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; agent: AgentSummary }>();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);

  // Live model → context-window map (OpenRouter catalog, cached server-side),
  // fetched once so the Model field can show the real window for the typed
  // slug — the same source the dashboard's context-% bars use.
  const [contextLimits, setContextLimits] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    fetch('/api/model-context')
      .then((r) => (r.ok ? r.json() : null))
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
    fetch(`/api/models?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? r.json() : null))
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
    fetch(`/api/models?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? r.json() : null))
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

  // "Make backup primary" — exchange the primary↔backup form values. The
  // runtime always treats the primary columns as the active route, so this
  // pure value-swap is the whole switch (mirrors the embedding page + the
  // documented chat-failover design). Only meaningful when a backup exists.
  const swapPrimaryBackup = () =>
    setForm((f) => ({
      ...f,
      provider: f.backupProvider || 'openrouter',
      model: f.backupModel,
      apiKeyId: f.backupApiKeyId,
      baseUrl: f.backupBaseUrl,
      viaTailnet: f.backupViaTailnet,
      backupProvider: f.provider,
      backupModel: f.model,
      backupApiKeyId: f.apiKeyId,
      backupBaseUrl: f.baseUrl,
      backupViaTailnet: f.viaTailnet,
    }));

  const openCreate = () => {
    setForm(emptyForm());
    setSlugTouched(false);
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

  const onNameChange = (v: string) => {
    setForm((f) => ({
      ...f,
      name: v,
      slug: slugTouched ? f.slug : slugify(v),
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

    const params: { temperature?: number; max_tokens?: number } = {};
    const t = parseFloat(form.temperature);
    if (!Number.isNaN(t)) params.temperature = t;
    const mt = form.maxTokens.trim();
    if (mt) {
      const n = parseInt(mt, 10);
      if (!Number.isNaN(n)) params.max_tokens = n;
    }

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
      systemPrompt: form.systemPrompt,
      memoryConfig,
      params,
      priority: Number.isNaN(priority) ? 100 : priority,
      enabled: form.enabled,
      toolSlugs: form.toolSlugs,
      skillSlugs: form.skillSlugs,
      avatar: form.avatar,
      ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
    };

    const url = editing.mode === 'create' ? '/api/agents' : `/api/agents/${editing.agent.id}`;
    const method = editing.mode === 'create' ? 'POST' : 'PATCH';
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Save failed.');
      return;
    }
    toast.success(editing.mode === 'create' ? 'Agent created' : 'Agent saved');
    // Keep focus on the just-saved row instead of dropping back to the
    // empty-detail state. Both POST and PATCH return `{ agent: row }`;
    // we promote the saved record into `editing` (turning a create into an
    // edit naturally — slug/id are now known) and resync the form fields
    // to whatever the server canonicalised. router.refresh() then repaints
    // the list around the still-selected row.
    const body2 = (await res.json().catch(() => ({}))) as { agent?: AgentSummary };
    if (body2.agent) {
      const saved = body2.agent;
      setEditing({ mode: 'edit', agent: saved });
      setForm(formFromAgent(saved));
      setSlugTouched(true);
      // Upsert the canonical row into the local list right away so the row
      // (avatar, name, badges) repaints deterministically — don't rely solely
      // on router.refresh()'s re-fetch, which races this client state and
      // intermittently leaves the row stale (e.g. avatar not updating until a
      // second save). Mirrors the delete path, which also mutates `agents`
      // directly. router.refresh() below still reconciles ordering.
      setAgents((prev) => {
        const idx = prev.findIndex((x) => x.id === saved.id);
        if (idx === -1) return [...prev, saved];
        const next = prev.slice();
        next[idx] = saved;
        return next;
      });
    } else {
      closeDialog();
    }
    startTransition(() => router.refresh());
  };

  const confirmDelete = async () => {
    const a = deleteTarget;
    if (!a) return;
    const res = await fetch(`/api/agents/${a.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Delete failed.');
      return;
    }
    toast.success(`Deleted ${a.name}`);
    if (editing?.mode === 'edit' && editing.agent.id === a.id) closeDialog();
    setAgents((prev) => prev.filter((x) => x.id !== a.id));
    startTransition(() => router.refresh());
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Active responder banner */}
      <div className="shrink-0 border-b border-border px-4 py-2 text-xs">
        {activeResponder ? (
          <p className="text-muted-foreground">
            Active Telegram responder:{' '}
            <strong className="text-foreground">{activeResponder.name}</strong> ({activeResponder.model},
            priority {activeResponder.priority})
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
          <div className="space-y-1.5 p-2 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
            {agents.length === 0 ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                No agents yet. Click <strong>New</strong> to create one — you&apos;ll need an API
                key saved at <code>/settings/keys</code> first.
              </p>
            ) : (
              agents.map((a) => {
                const selected = selectedId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => openEdit(a)}
                    className={cn(
                      'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-accent/40',
                      selected && 'border-l-primary bg-accent/50',
                      !a.enabled && 'opacity-60',
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      {a.avatar ? (
                        <BoringAvatar variant={a.avatar.style} seed={a.avatar.seed} size={32} />
                      ) : (
                        <span
                          className="flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                          style={{ backgroundColor: agentAccent(a.slug).solid }}
                          aria-hidden
                        >
                          {agentInitials(a.name)}
                        </span>
                      )}
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
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right: editor ────────────────────────────────────────── */}
        <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
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
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(editing.agent)}
                    >
                      <Trash2 /> Delete
                    </Button>
                  )}
                </div>
              </div>
              <form onSubmit={submitForm} className="space-y-4">
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
                />
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
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Default Telegram responder, with memory"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Avatar</Label>
              <AvatarPicker
                value={form.avatar}
                onChange={(v) => setForm((f) => ({ ...f, avatar: v }))}
                fallbackSeed={form.slug || form.name || 'agent'}
              />
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
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
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
                />
              </div>
            </div>

            {/* Provider + model + key grid. Post-Phase-3 the provider
                field on the agent row actually controls runtime
                dispatch — `getChatAdapter(agent.provider)` resolves the
                adapter the responder / assistant / heartbeat loop runs
                through, and the API key filter narrows accordingly. */}
            <div className="grid gap-3 sm:grid-cols-3">
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
                      {!isProviderWired(form.provider, 'chat') && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          No chat adapter registered for{' '}
                          <code>{form.provider}</code>. Saves will succeed but
                          the responder/assistant will fail at first turn until
                          a chat adapter ships for this provider.
                        </p>
                      )}
                    </>
                  );
                })()}
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
                      <code>{form.model}</code> isn&apos;t in{' '}
                      <code>{form.provider}</code>&apos;s catalog. Save will
                      succeed but the call will fail if the slug is wrong —
                      direct providers use bare ids (e.g.{' '}
                      <code>claude-haiku-4-5</code>) where OpenRouter uses
                      prefixed slugs (e.g.{' '}
                      <code>anthropic/claude-haiku-4.5</code>).
                    </p>
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
                          None of your saved keys are for{' '}
                          <code>{form.provider}</code>. Add one at{' '}
                          <a href="/settings/keys" className="underline">
                            /settings/keys
                          </a>{' '}
                          or pick a different provider.
                        </p>
                      )}
                      {apiKeys.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          No keys saved.{' '}
                          <a href="/settings/keys" className="underline">
                            Add one
                          </a>{' '}
                          first.
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Primary route host + tailnet (migration 0063). Only meaningful
                for the `local` chat adapter — a self-hosted/LAN/tailnet box. */}
            {form.provider === 'local' && (
              <RouteHostFields
                idPrefix="primary"
                baseUrl={form.baseUrl}
                viaTailnet={form.viaTailnet}
                peers={tailnetPeers}
                onBaseUrl={(v) => setForm((f) => ({ ...f, baseUrl: v }))}
                onViaTailnet={(v) => setForm((f) => ({ ...f, viaTailnet: v }))}
              />
            )}

            {/* ── Backup chat route (failover) ──────────────────────────────
                Unlike embeddings, a chat backup may be a DIFFERENT provider +
                model — there's no vector-space lock. When failover is on and
                the primary is unreachable (route-down / 429 / 5xx), the
                responder/assistant/heartbeat loop answers here (sticky for the
                rest of that turn). See docs/chat-failover.md. */}
            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Backup route
              </legend>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="backupEnabled" className="cursor-pointer">
                    Enable failover
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    On a route-down / 429 / 5xx from the primary, fall over to a
                    backup route. May be a different provider + model — that&apos;s
                    what enables a local primary with a cloud safety net (or the
                    reverse).
                  </p>
                </div>
                <Switch
                  id="backupEnabled"
                  checked={form.backupEnabled}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, backupEnabled: v }))}
                />
              </div>

              {form.backupEnabled && (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      The <strong>primary</strong> above is always the active route.
                      Swap to promote this backup.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={swapPrimaryBackup}
                    >
                      <ArrowLeftRight />
                      Make backup primary
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="backupProvider">Provider</Label>
                      {(() => {
                        const chatProviders = providersForCapability('chat');
                        return (
                          <>
                            <select
                              id="backupProvider"
                              value={form.backupProvider}
                              onChange={(e) =>
                                setForm((f) => ({ ...f, backupProvider: e.target.value }))
                              }
                              className={SELECT_CLASS}
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
                            {!isProviderWired(form.backupProvider, 'chat') && (
                              <p className="text-xs text-amber-600 dark:text-amber-400">
                                No chat adapter registered for{' '}
                                <code>{form.backupProvider}</code> — failover to it
                                will fail until one ships.
                              </p>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="backupModel">Model</Label>
                      <ModelSelect
                        id="backupModel"
                        value={form.backupModel}
                        onValueChange={(next) =>
                          setForm((f) => ({ ...f, backupModel: next }))
                        }
                        models={backupCatalog}
                        loading={backupCatalogState.loading}
                        error={backupCatalogState.error}
                        placeholder="— pick a model —"
                        emptyMessage="No matching models in the catalog."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="backupApiKey">API key</Label>
                      {(() => {
                        const eligibleBackupKeys = apiKeys.filter(
                          (k) => k.service === form.backupProvider,
                        );
                        return (
                          <>
                            <select
                              id="backupApiKey"
                              value={form.backupApiKeyId}
                              onChange={(e) =>
                                setForm((f) => ({ ...f, backupApiKeyId: e.target.value }))
                              }
                              className={SELECT_CLASS}
                            >
                              <option value="">
                                {form.backupProvider === 'local'
                                  ? 'None (keyless / local)'
                                  : '— select a key —'}
                              </option>
                              {eligibleBackupKeys.map((k) => (
                                <option key={k.id} value={k.id}>
                                  {k.service} / {k.label} ({k.masked})
                                </option>
                              ))}
                            </select>
                            {apiKeys.length > 0 &&
                              eligibleBackupKeys.length === 0 &&
                              form.backupProvider !== 'local' && (
                                <p className="text-xs text-amber-600 dark:text-amber-400">
                                  None of your saved keys are for{' '}
                                  <code>{form.backupProvider}</code>.
                                </p>
                              )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  {form.backupProvider === 'local' && (
                    <RouteHostFields
                      idPrefix="backup"
                      baseUrl={form.backupBaseUrl}
                      viaTailnet={form.backupViaTailnet}
                      peers={tailnetPeers}
                      onBaseUrl={(v) => setForm((f) => ({ ...f, backupBaseUrl: v }))}
                      onViaTailnet={(v) => setForm((f) => ({ ...f, backupViaTailnet: v }))}
                    />
                  )}
                </>
              )}
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="systemPrompt">System prompt</Label>
              <textarea
                id="systemPrompt"
                value={form.systemPrompt}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
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
                Memory
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="historyLimit">Turns to replay</Label>
                  <Input
                    id="historyLimit"
                    type="number"
                    value={form.historyLimit}
                    onChange={(e) => setForm((f) => ({ ...f, historyLimit: e.target.value }))}
                    min={0}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">
                    {form.role === 'summarizer'
                      ? 'Unused for summarizers — leave at 0.'
                      : 'Default 20.'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historyWindowHours">Time window (hours)</Label>
                  <Input
                    id="historyWindowHours"
                    type="number"
                    value={form.historyWindowHours}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, historyWindowHours: e.target.value }))
                    }
                    placeholder="(none — count only)"
                    min={0}
                    step={0.5}
                  />
                </div>
              </div>

              {(form.role === 'responder' || form.role === 'assistant') && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="digestLimit">Digests</Label>
                    <Input
                      id="digestLimit"
                      type="number"
                      value={form.digestLimit}
                      onChange={(e) => setForm((f) => ({ ...f, digestLimit: e.target.value }))}
                      min={0}
                      step={1}
                    />
                    <p className="text-xs text-muted-foreground">Default 3</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="factLimit">Facts</Label>
                    <Input
                      id="factLimit"
                      type="number"
                      value={form.factLimit}
                      onChange={(e) => setForm((f) => ({ ...f, factLimit: e.target.value }))}
                      min={0}
                      step={1}
                    />
                    <p className="text-xs text-muted-foreground">Default 10</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="contentHitLimit">Content hits</Label>
                    <Input
                      id="contentHitLimit"
                      type="number"
                      value={form.contentHitLimit}
                      onChange={(e) => setForm((f) => ({ ...f, contentHitLimit: e.target.value }))}
                      min={0}
                      step={1}
                    />
                    <p className="text-xs text-muted-foreground">Default 3</p>
                  </div>
                </div>
              )}

              {form.role === 'extractor' && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Node types to process</Label>
                    <NodeTypePicker
                      value={form.extractTypes}
                      onChange={(v) => setForm((f) => ({ ...f, extractTypes: v }))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Click a chip to toggle. <strong>all types</strong> is a
                      wildcard — matches every node type the extractor sees, so the
                      specific chips become redundant when it&apos;s on. Add a custom
                      type if you&apos;ve introduced a new node kind.{' '}
                      <code>branch</code> and <code>secret</code> are HARD-SKIPPED
                      regardless of this setting.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.extractFacts}
                      onChange={(e) => setForm((f) => ({ ...f, extractFacts: e.target.checked }))}
                    />
                    Extract facts (uncheck for content_index population only)
                  </label>
                  <div className="space-y-1.5">
                    <Label htmlFor="extractCostCapCents">Cost cap per run (¢)</Label>
                    <Input
                      id="extractCostCapCents"
                      type="number"
                      step={0.1}
                      min={0}
                      value={form.extractCostCapCents}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, extractCostCapCents: e.target.value }))
                      }
                      placeholder="(none — unlimited)"
                    />
                    <p className="text-xs text-muted-foreground">
                      Once trace cost crosses this, the fact-processing loop bails
                      gracefully. Summary + entity reconciliation still run. Empty = no cap.
                    </p>
                  </div>
                </div>
              )}

              {form.role === 'summarizer' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="summarizeThreshold">Trigger threshold</Label>
                    <Input
                      id="summarizeThreshold"
                      type="number"
                      value={form.summarizeThreshold}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, summarizeThreshold: e.target.value }))
                      }
                      min={1}
                      step={1}
                    />
                    <p className="text-xs text-muted-foreground">
                      Undigested turns per chat before summarization fires. Default 30.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="summarizeBatch">Batch size</Label>
                    <Input
                      id="summarizeBatch"
                      type="number"
                      value={form.summarizeBatch}
                      onChange={(e) => setForm((f) => ({ ...f, summarizeBatch: e.target.value }))}
                      min={1}
                      step={1}
                    />
                    <p className="text-xs text-muted-foreground">
                      How many of the oldest turns to fold into one digest. Default 20.
                    </p>
                  </div>
                </div>
              )}

            </fieldset>

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
                  and paste the token — it&apos;s encrypted at rest. DMs to this bot are answered
                  by this agent.
                </p>
              </fieldset>
            )}

            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tools
              </legend>
              {availableTools.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No tools registered yet. The agent runner seeds built-ins on boot — start
                  <code> pnpm dev</code> and revisit.
                </p>
              ) : (
                <ToolPicker
                  available={availableTools}
                  selected={form.toolSlugs}
                  onChange={(next) => setForm((f) => ({ ...f, toolSlugs: next }))}
                />
              )}
              <p className="text-xs text-muted-foreground">
                The agent may call these mid-turn. Empty selection = the agent never sees a
                <code> tools</code> parameter (behaves like before). Tools marked{' '}
                <em>requires confirm</em> get queued at{' '}
                <a href="/pending" className="underline">/pending</a> instead of
                auto-running.
              </p>
            </fieldset>

            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Skills
              </legend>
              {availableSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No skills yet. Author one at{' '}
                  <a href="/settings/skills" className="underline">/settings/skills</a>.
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
                prompt and joins its suggested tools into the agent&apos;s allowlist
                (always-loaded mode).
              </p>
            </fieldset>

            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Delegates to
              </legend>
              {agents.filter((a) => a.slug !== form.slug).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No other agents to delegate to. Create another agent (e.g. a research or
                  recall agent) first.
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
                {form.delegateTo.length > 0 && !form.toolSlugs.includes('invoke_agent') && (
                  <span className="mt-1 block text-amber-600 dark:text-amber-400">
                    Add the <code>invoke_agent</code> tool above, or these delegates
                    can&apos;t actually be reached.
                  </span>
                )}
              </p>
            </fieldset>

            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tool results
              </legend>
              <p className="text-xs text-muted-foreground">
                Large tool outputs (a delegated agent&apos;s full answer, a big file read,
                a wide search) are stored and handed to the agent as a handle it reads via{' '}
                <code>read_result</code> (page / grep / semantic query) — instead of being
                truncated. Tune when that spill kicks in. Blank = system default.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="result-inline">Inline max (KB)</Label>
                  <Input
                    id="result-inline"
                    type="number"
                    min={1}
                    value={form.resultInlineMaxKb}
                    onChange={(e) => setForm((f) => ({ ...f, resultInlineMaxKb: e.target.value }))}
                    placeholder="32 (default)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Results larger than this spill to the store.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="result-embed">Semantic-tier (KB)</Label>
                  <Input
                    id="result-embed"
                    type="number"
                    min={1}
                    value={form.resultEmbedMinKb}
                    onChange={(e) => setForm((f) => ({ ...f, resultEmbedMinKb: e.target.value }))}
                    placeholder="100 (default)"
                  />
                  <p className="text-xs text-muted-foreground">
                    At/over this, the agent is steered to semantic <code>query</code>.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="result-spill">Hard ceiling (KB)</Label>
                  <Input
                    id="result-spill"
                    type="number"
                    min={1}
                    value={form.resultSpillMaxKb}
                    onChange={(e) => setForm((f) => ({ ...f, resultSpillMaxKb: e.target.value }))}
                    placeholder="1024 (default)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Bigger results are head-truncated before storing (caps DB + embedding cost).
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Max embedding chunks and retention (TTL) are system-wide — set via{' '}
                <code>TOOL_RESULT_MAX_CHUNKS</code> / <code>TOOL_RESULT_TTL_DAYS</code> env vars.
              </p>
            </fieldset>

            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Model params
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label>Temperature</Label>
                    <span className="text-xs">
                      <span className="font-medium text-foreground">{tempDescriptor(temp).word}</span>
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
                    onValueChange={([v]) => setForm((f) => ({ ...f, temperature: String(v ?? 0) }))}
                    className="py-1.5"
                    aria-label="Temperature"
                  />
                  <p className="text-xs text-muted-foreground">{tempDescriptor(temp).hint}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="maxTokens">Max tokens</Label>
                  <Input
                    id="maxTokens"
                    type="number"
                    step={1}
                    min={1}
                    value={form.maxTokens}
                    onChange={(e) => setForm((f) => ({ ...f, maxTokens: e.target.value }))}
                    placeholder="(provider default)"
                  />
                </div>
              </div>
            </fieldset>

            {editing.mode === 'edit' && (
              <PersonaNotesEditor
                key={editing.agent.id}
                agentId={editing.agent.id}
                initialNotes={editing.agent.personaNotes}
              />
            )}

            {editing.mode === 'edit' && (
              <section className="space-y-2 border-t border-border pt-6">
                <h3 className="text-sm font-semibold">Test chat</h3>
                <p className="text-xs text-muted-foreground">
                  Send a one-shot prompt through this agent&apos;s adapter (
                  <code>{editing.agent.provider}</code>) and see what comes back.
                  Uses the saved system prompt, model, and params — same path as
                  the production responder. Useful for validating a new direct-
                  provider key (Anthropic / Google / xAI) without sending a real
                  Telegram message.
                </p>
                <AgentChatTestButton agentId={editing.agent.id} />
              </section>
            )}

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <SubmitButton pending={pending}>
                {editing.mode === 'create' ? 'Create agent' : 'Save agent'}
              </SubmitButton>
            </div>
              </form>
            </div>
          )}
        </div>
      </div>

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
 * Chip multi-select for node types. The form state is still a
 * comma-separated string so the save path stays unchanged; this is
 * just a friendlier surface over it.
 */
function NodeTypePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const selected = new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const [customDraft, setCustomDraft] = useState('');

  // Render known types first (in their fixed order), then any custom
  // values not already in the known set.
  const known = KNOWN_NODE_TYPES;
  const customs = Array.from(selected).filter(
    (t) => t !== '*' && !known.includes(t as (typeof KNOWN_NODE_TYPES)[number]),
  );

  const commit = (next: Set<string>) => {
    onChange(Array.from(next).join(','));
  };

  const toggle = (t: string) => {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    commit(next);
  };

  const addCustom = () => {
    const t = customDraft.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!t) return;
    const next = new Set(selected);
    next.add(t);
    commit(next);
    setCustomDraft('');
  };

  const wildcardOn = selected.has('*');

  // Chip styling: selection is marked by an ACCENT (primary border + a faint
  // accent tint), never a solid background fill. A saturated fill (the old
  // bg-primary / bg-emerald / bg-amber) drowns the chip label and any muted
  // text in many of the ~40 themes — the readability bug we're fixing. All
  // token-based (no hardcoded emerald/amber) so it tracks the active theme.
  const chipBase = 'rounded-full border px-2.5 py-0.5 text-xs transition';
  const chipOff =
    'border-input bg-background text-muted-foreground hover:bg-accent/40 hover:text-foreground';
  const chipOn = 'border-primary bg-accent/50 text-foreground';
  // Implicitly on because the wildcard covers it — same accent family, but
  // de-emphasized (dashed border, muted label) so an explicit pick still reads
  // distinctly from "covered by all types".
  const chipCovered = 'border-dashed border-primary/40 bg-accent/30 text-muted-foreground';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {/* Wildcard chip: matches any non-HARD_SKIP type. When on, the
            specific chips below stay clickable (additive — clicking one
            just turns off the wildcard for clarity). */}
        <button
          type="button"
          onClick={() => toggle('*')}
          className={cn(chipBase, 'font-medium', wildcardOn ? chipOn : chipOff)}
          title="Wildcard — match every non-secret, non-branch node type"
        >
          all types
        </button>
        {known.map((t) => {
          const on = selected.has(t) || wildcardOn;
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              className={cn(
                chipBase,
                'font-mono',
                wildcardOn ? chipCovered : on ? chipOn : chipOff,
              )}
              title={wildcardOn ? 'covered by "all types"' : undefined}
            >
              {t}
            </button>
          );
        })}
        {customs.filter((t) => t !== '*').map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            className={cn(chipBase, 'font-mono', chipOn)}
            title="Custom type — click to remove"
          >
            {t} ✕
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="add custom type"
          className="h-7 text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addCustom}
          disabled={!customDraft.trim()}
        >
          Add
        </Button>
      </div>
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
    meta:
      s.toolSlugs.length > 0 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          +{s.toolSlugs.length} tool{s.toolSlugs.length === 1 ? '' : 's'}
        </span>
      ) : undefined,
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
 * Telegram bot binding for a responder. Loads the agent's currently-linked bot
 * (if any) and lets the operator paste a token to connect / rotate, or
 * disconnect. The token is validated (getMe) + sealed server-side; only the
 * bot @username + poll status come back here.
 */
function TelegramBotSection({ agentId }: { agentId: string }) {
  const toast = useToast();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  // undefined = loading, null = not linked.
  const [binding, setBinding] = useState<AgentTelegramBinding | null | undefined>(undefined);
  const [chats, setChats] = useState<AgentTelegramChat[]>([]);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyChat, setBusyChat] = useState<string | null>(null);

  // `initial` shows the loading state + flips to null on failure; polled
  // refreshes update in place without flashing.
  const load = useCallback(
    async (initial = false) => {
      if (initial) setBinding(undefined);
      try {
        const res = await fetch(`/api/agents/${agentId}/telegram`);
        const b = (await res.json()) as {
          binding?: AgentTelegramBinding | null;
          chats?: AgentTelegramChat[];
        };
        setBinding(b.binding ?? null);
        setChats(b.chats ?? []);
      } catch {
        if (initial) setBinding(null);
      }
    },
    [agentId],
  );

  useEffect(() => {
    setToken('');
    void load(true);
    // Poll so a fresh DM's pairing request shows up without a manual refresh.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    const res = await fetch(`/api/agents/${agentId}/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    });
    setBusy(false);
    const b = (await res.json().catch(() => ({}))) as {
      binding?: AgentTelegramBinding;
      error?: string;
    };
    if (!res.ok || !b.binding) {
      toast.error(b.error ?? 'Could not link the bot.');
      return;
    }
    setToken('');
    toast.success(`Linked @${b.binding.botUsername}`);
    void load();
    startRefresh(() => router.refresh());
  };

  const disconnect = async () => {
    setBusy(true);
    const res = await fetch(`/api/agents/${agentId}/telegram`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      toast.error('Could not unlink the bot.');
      return;
    }
    setBinding(null);
    setChats([]);
    setToken('');
    toast.success('Bot unlinked');
    startRefresh(() => router.refresh());
  };

  const setChatStatus = async (chatId: string, status: 'allowed' | 'denied') => {
    setBusyChat(chatId);
    const res = await fetch(`/api/agents/${agentId}/telegram/chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, status }),
    });
    setBusyChat(null);
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Could not update the chat.');
      return;
    }
    toast.success(status === 'allowed' ? 'Paired' : 'Blocked');
    void load();
  };

  if (binding === undefined) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading…
      </div>
    );
  }

  const pending = chats.filter((c) => c.status === 'pending');
  const allowedCount = chats.filter((c) => c.status === 'allowed').length;

  return (
    <div className="space-y-2">
      {binding && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
            <Send className="size-3.5" aria-hidden />@{binding.botUsername}
          </span>
          {binding.enabled ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> polling
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">disabled</span>
          )}
          {allowedCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {allowedCount} paired chat{allowedCount === 1 ? '' : 's'}
            </span>
          )}
          {binding.lastPollError && (
            <span className="truncate text-xs text-destructive" title={binding.lastPollError}>
              {binding.lastPollError}
            </span>
          )}
        </div>
      )}

      {/* Pending pairing requests — approve a DM without copying a code. */}
      {pending.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Pairing request{pending.length === 1 ? '' : 's'} — someone DM&apos;d this bot
          </p>
          {pending.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {c.label}{' '}
                <code className="text-[11px] text-muted-foreground">{c.telegramChatId}</code>
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => setChatStatus(c.id, 'allowed')}
                disabled={busyChat === c.id}
              >
                {busyChat === c.id && <Loader2 className="animate-spin" aria-hidden />}
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setChatStatus(c.id, 'denied')}
                disabled={busyChat === c.id}
              >
                Block
              </Button>
            </div>
          ))}
        </div>
      )}

      <input
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void connect();
          }
        }}
        placeholder={binding ? 'Paste a new token to rotate…' : 'Paste your bot token…'}
        className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={connect} disabled={busy || !token.trim()}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {binding ? 'Update token' : 'Connect bot'}
        </Button>
        {binding && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={disconnect}
            disabled={busy}
          >
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Readout under the Model field showing the resolved context window for the
 * typed slug, from the live OpenRouter map (static fallback) fetched by the
 * form. Renders nothing until a model is entered; says so plainly when a
 * slug isn't in the catalog (usually a typo in the id).
 */
function ContextWindowHint({
  model,
  limits,
}: {
  model: string;
  limits: Record<string, number>;
}) {
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
      Context window:{' '}
      <span className="font-medium text-foreground tabular-nums">{pretty}</span> tokens (
      {limit.toLocaleString()})
    </p>
  );
}

/** Per-route host + tailnet controls for a `local` chat route (migration 0063).
 *  `baseUrl` overrides the default localhost host (point it at a LAN/tailnet
 *  box); `viaTailnet` routes the request through the bundled Tailscale proxy so
 *  a MagicDNS name reaches a box behind NAT. Rendered only when the route's
 *  provider is `local` — other providers have fixed endpoints. */
function RouteHostFields({
  idPrefix,
  baseUrl,
  viaTailnet,
  peers = [],
  onBaseUrl,
  onViaTailnet,
}: {
  idPrefix: string;
  baseUrl: string;
  viaTailnet: boolean;
  /** Online tailnet peer MagicDNS names — surfaced as base-URL autocomplete. */
  peers?: string[];
  onBaseUrl: (v: string) => void;
  onViaTailnet: (v: boolean) => void;
}) {
  const listId = `${idPrefix}-tailnet-peers`;
  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}BaseUrl`}>Base URL</Label>
        <Input
          id={`${idPrefix}BaseUrl`}
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          placeholder="blank = http://localhost:11434/v1 (Ollama default)"
          list={peers.length > 0 ? listId : undefined}
        />
        {peers.length > 0 && (
          // Suggest tailnet peers as `http://<name>:PORT/v1`. Free-text still
          // works; this is just autocomplete when a tailnet is up.
          <datalist id={listId}>
            {peers.map((p) => (
              <option key={p} value={`http://${p}:1234/v1`} />
            ))}
          </datalist>
        )}
        <p className="text-xs text-muted-foreground">
          Where this <code>local</code> route&apos;s server lives — e.g.{' '}
          <code>http://gemma-box:11434/v1</code> (Ollama) or{' '}
          <code>http://192.168.0.50:1234/v1</code> (LM Studio). Blank uses the{' '}
          <code>MANTLE_LOCAL_CHAT_URL</code> env / localhost default.
          {peers.length > 0 && ' Tailnet devices are suggested as you type.'}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor={`${idPrefix}ViaTailnet`} className="cursor-pointer">
            Reach via Tailscale
          </Label>
          <p className="text-xs text-muted-foreground">
            Route this request through the bundled Tailscale proxy so the Base URL
            (a MagicDNS name) reaches a box behind NAT. Inert unless the{' '}
            <code>tailnet</code> compose profile is up.
          </p>
        </div>
        <Switch
          id={`${idPrefix}ViaTailnet`}
          checked={viaTailnet}
          onCheckedChange={onViaTailnet}
        />
      </div>
    </div>
  );
}
