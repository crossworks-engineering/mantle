'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Built-in node types the extractor can be allow-listed against. Matches
 *  the `node_type` enum in packages/db/src/schema/nodes.ts minus the
 *  HARD_SKIP set (`branch`, `secret`) which the extractor refuses regardless. */
const KNOWN_NODE_TYPES = [
  'note',
  'file',
  'email',
  'email_thread',
  'sermon',
  'contact',
  'task',
  'event',
  'printer_project',
  'telegram_message',
] as const;

/** Curated embedding models — all output (or can be coerced to) 1536 dims to
 *  match the `nodes.embedding vector(1536)` column. Empty value = fall back to
 *  MANTLE_EMBEDDING_MODEL env (or the hard-coded `openai/text-embedding-3-small`). */
const EMBEDDING_MODELS: { value: string; label: string; note?: string }[] = [
  { value: '', label: 'Default (env / openai/text-embedding-3-small)', note: '1536 dims · $0.02/1M tok' },
  { value: 'openai/text-embedding-3-small', label: 'openai/text-embedding-3-small', note: '1536 dims · $0.02/1M tok' },
  { value: 'google/gemini-embedding-001', label: 'google/gemini-embedding-001', note: 'configurable → 1536 · $0.15/1M tok' },
  { value: 'google/gemini-embedding-2-preview', label: 'google/gemini-embedding-2-preview', note: 'multimodal · 1536 · $0.20/1M tok' },
];

/** Common OpenRouter model slugs. Free text still works for anything not listed. */
const MODEL_SUGGESTIONS = [
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
];

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
  embedding_model?: string;
};

type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: Role;
  model: string;
  apiKeyId: string | null;
  systemPrompt: string;
  tools: string[];
  toolSlugs: string[];
  skillSlugs: string[];
  memoryConfig: MemoryConfig;
  params: { temperature?: number; max_tokens?: number; top_p?: number };
  priority: number;
  enabled: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

type ApiKeyOption = { id: string; service: string; label: string; masked: string };

export type ToolOption = {
  slug: string;
  name: string;
  description: string;
  requiresConfirm: boolean;
  kind: string;
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

const DEFAULT_EXTRACTOR_PROMPT = `You are a memory extractor for a personal AI assistant. You will be given the title and body of a piece of content (a note, document, email, etc.) belonging to a single user. Your job is to produce TWO outputs:

1. A 1-2 sentence summary of what this content is about. Be specific — names, dates, projects, numbers. Avoid filler.

2. A list of facts about the user or their world that this content reveals. Each fact is a single declarative sentence with the entities mentioned (people, projects, places, organisations, events) for cross-referencing.

Output STRICT JSON, no markdown:

{
  "summary": "<1-2 sentences>",
  "facts": [{ "content": "<sentence>", "kind": "factual|episodic|semantic|preference", "confidence": 0.0-1.0, "entities": [{ "name": "...", "kind": "person|project|place|org|event" }] }],
  "entities": [{ "name": "...", "kind": "..." }]
}

Guidelines:
- factual = verifiable claim with a value.
- episodic = something that happened on a date.
- semantic = a stable abstract identity.
- preference = how the user prefers to be helped.
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
  model: string;
  apiKeyId: string;
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
  /** OpenRouter slug. Empty = use the env default. */
  embeddingModel: string;
  /** Slugs this agent may call during a turn. */
  toolSlugs: string[];
  temperature: string;
  maxTokens: string;
};

function emptyForm(role: Role = 'responder'): FormState {
  const d = defaultsForRole(role);
  return {
    slug: '',
    name: '',
    description: '',
    role,
    model: d.model,
    apiKeyId: '',
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
    embeddingModel: '',
    toolSlugs: [],
    temperature: '0.7',
    maxTokens: '',
  };
}

function formFromAgent(a: AgentSummary): FormState {
  const d = defaultsForRole(a.role);
  return {
    slug: a.slug,
    name: a.name,
    description: a.description ?? '',
    role: a.role,
    model: a.model,
    apiKeyId: a.apiKeyId ?? '',
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
    embeddingModel: a.memoryConfig.embedding_model ?? '',
    toolSlugs: a.toolSlugs ?? [],
    temperature: a.params.temperature?.toString() ?? '0.7',
    maxTokens: a.params.max_tokens?.toString() ?? '',
  };
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
}: {
  initialAgents: AgentSummary[];
  apiKeys: ApiKeyOption[];
  availableTools: ToolOption[];
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[]>(initialAgents);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  // After a create/edit, we call router.refresh() to re-run the server
  // component; this hook propagates the new list into our local state.
  // (useState's initialValue is only read on first mount.)
  useEffect(() => {
    setAgents(initialAgents);
  }, [initialAgents]);

  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; agent: AgentSummary }>();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);

  const openCreate = () => {
    setError(undefined);
    setForm(emptyForm());
    setSlugTouched(false);
    setEditing({ mode: 'create' });
  };

  const openEdit = (agent: AgentSummary) => {
    setError(undefined);
    setForm(formFromAgent(agent));
    setSlugTouched(true);
    setEditing({ mode: 'edit', agent });
  };

  const closeDialog = () => {
    setEditing(undefined);
    setError(undefined);
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
    setError(undefined);

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
    // Embedding model: shown for any role that embeds. Empty value = use env default.
    if (
      form.role === 'extractor' ||
      form.role === 'responder' ||
      form.role === 'assistant'
    ) {
      const m = form.embeddingModel.trim();
      if (m) memoryConfig.embedding_model = m;
    }

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
      model: form.model.trim(),
      apiKeyId: form.apiKeyId || null,
      systemPrompt: form.systemPrompt,
      memoryConfig,
      params,
      priority: Number.isNaN(priority) ? 100 : priority,
      enabled: form.enabled,
      toolSlugs: form.toolSlugs,
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
      setError(b.error ?? 'Save failed.');
      return;
    }
    closeDialog();
    startTransition(() => router.refresh());
  };

  const toggleEnabled = async (a: AgentSummary) => {
    const res = await fetch(`/api/agents/${a.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !a.enabled }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'Toggle failed.');
      return;
    }
    setAgents((prev) => prev.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)));
    startTransition(() => router.refresh());
  };

  const onDelete = async (a: AgentSummary) => {
    if (!confirm(`Delete agent "${a.name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/agents/${a.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'Delete failed.');
      return;
    }
    setAgents((prev) => prev.filter((x) => x.id !== a.id));
    startTransition(() => router.refresh());
  };

  const apiKeyById = useMemo(() => {
    const m = new Map<string, ApiKeyOption>();
    for (const k of apiKeys) m.set(k.id, k);
    return m;
  }, [apiKeys]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Configured agents
        </h2>
        <Button type="button" onClick={openCreate}>
          New agent
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {agents.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No agents yet. Click <strong>New agent</strong> to create one — you&apos;ll need an
          API key saved at <code>/settings/keys</code> first.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {agents.map((a) => {
            const key = a.apiKeyId ? apiKeyById.get(a.apiKeyId) : null;
            return (
              <li key={a.id} className="flex items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">/ {a.slug}</span>
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {a.role}
                    </span>
                    {!a.enabled && (
                      <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <code className="font-mono">{a.model}</code>
                    <span>priority {a.priority}</span>
                    {a.role === 'responder' && (
                      <>
                        <span>history {a.memoryConfig.history_limit ?? 20} turns</span>
                        <span>{a.memoryConfig.digest_limit ?? 3} digests</span>
                      </>
                    )}
                    {a.role === 'summarizer' && (
                      <span>
                        rolls up every {a.memoryConfig.summarize_threshold ?? 30} turns ·
                        batch {a.memoryConfig.summarize_batch ?? 20}
                      </span>
                    )}
                    <span>
                      key:{' '}
                      {key ? (
                        <span>
                          {key.service}/{key.label}
                        </span>
                      ) : (
                        <span className="text-destructive">— none —</span>
                      )}
                    </span>
                    <span>
                      last used {a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleString() : 'never'}
                    </span>
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={() => toggleEnabled(a)}
                    disabled={pending}
                    className="size-3.5"
                  />
                  enabled
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(a)}>
                  <Pencil className="size-3.5" aria-hidden /> Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(a)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden /> Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!editing} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="!h-auto !max-h-[90vh] !max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === 'create' ? 'New agent' : `Edit ${editing?.mode === 'edit' ? editing.agent.name : ''}`}
            </DialogTitle>
            <DialogDescription>
              {editing?.mode === 'create'
                ? 'A new AI agent. Pick a stored API key, model, and persona.'
                : 'Update the agent. Slug is immutable.'}
            </DialogDescription>
          </DialogHeader>
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

            <div className="grid gap-3 sm:grid-cols-3">
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
                <Label htmlFor="model">Model</Label>
                <Input
                  id="model"
                  list="model-suggestions"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  required
                />
                <datalist id="model-suggestions">
                  {MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
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

            <div className="space-y-1.5">
              <Label htmlFor="apiKey">API key</Label>
              <select
                id="apiKey"
                value={form.apiKeyId}
                onChange={(e) => setForm((f) => ({ ...f, apiKeyId: e.target.value }))}
                className={SELECT_CLASS}
                required
              >
                <option value="">— select a key —</option>
                {apiKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.service} / {k.label} ({k.masked})
                  </option>
                ))}
              </select>
              {apiKeys.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No keys saved.{' '}
                  <a href="/settings/keys" className="underline">
                    Add one
                  </a>{' '}
                  first.
                </p>
              )}
            </div>

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

              {(form.role === 'extractor' ||
                form.role === 'responder' ||
                form.role === 'assistant') && (
                <div className="space-y-1.5 border-t border-border pt-3">
                  <Label htmlFor="embeddingModel">Embedding model</Label>
                  <select
                    id="embeddingModel"
                    value={form.embeddingModel}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, embeddingModel: e.target.value }))
                    }
                    className={SELECT_CLASS}
                  >
                    {EMBEDDING_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                        {m.note ? ` — ${m.note}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Used wherever this agent calls <code>embed()</code>. All listed
                    models output 1536-dim vectors (matching{' '}
                    <code>nodes.embedding</code>). <strong>Important:</strong> the
                    extractor&apos;s model must match the responder/assistant&apos;s for
                    retrieval to work — vectors from different models live in
                    different spaces and don&apos;t compare.
                  </p>
                </div>
              )}
            </fieldset>

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
                <em>requires confirm</em> will eventually pause for approval; auto-runs
                in v1.
              </p>
            </fieldset>

            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Model params
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="temperature">Temperature</Label>
                  <Input
                    id="temperature"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={form.temperature}
                    onChange={(e) => setForm((f) => ({ ...f, temperature: e.target.value }))}
                  />
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

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
              Enabled
            </label>

            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {editing?.mode === 'create' ? 'Create' : 'Save'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {/* Wildcard chip: matches any non-HARD_SKIP type. When on, the
            specific chips below stay clickable (additive — clicking one
            just turns off the wildcard for clarity). */}
        <button
          type="button"
          onClick={() => toggle('*')}
          className={
            'rounded-full border px-2.5 py-0.5 text-xs font-medium transition ' +
            (wildcardOn
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-input bg-background text-muted-foreground hover:border-muted-foreground/50')
          }
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
              className={
                'rounded-full border px-2.5 py-0.5 text-xs font-mono transition ' +
                (wildcardOn
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:border-muted-foreground/50')
              }
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
            className="rounded-full border border-amber-500/60 bg-amber-50 px-2.5 py-0.5 text-xs font-mono text-amber-900 transition dark:bg-amber-900/30 dark:text-amber-100"
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
function ToolPicker({
  available,
  selected,
  onChange,
}: {
  available: ToolOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const set = new Set(selected);
  const toggle = (slug: string) => {
    const next = new Set(set);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    onChange(Array.from(next));
  };

  // Group by handler kind so built-ins, http, shell each cluster.
  const groups = available.reduce<Record<string, ToolOption[]>>((acc, t) => {
    const k = t.kind;
    (acc[k] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      {Object.entries(groups).map(([kind, tools]) => (
        <div key={kind} className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {kind} · {tools.length}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tools.map((t) => {
              const on = set.has(t.slug);
              return (
                <button
                  key={t.slug}
                  type="button"
                  onClick={() => toggle(t.slug)}
                  title={t.description}
                  className={
                    'rounded-full border px-2.5 py-0.5 text-xs font-mono transition ' +
                    (on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background text-muted-foreground hover:border-muted-foreground/50')
                  }
                >
                  {t.slug}
                  {t.requiresConfirm && (
                    <span className="ml-1 text-[9px] uppercase opacity-70">⚠</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {selected.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {selected.length} tool{selected.length === 1 ? '' : 's'} selected
        </p>
      )}
    </div>
  );
}
