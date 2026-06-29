'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import type { ToolDTO, ToolHandler, ToolSettings } from '@mantle/client-types';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
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
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

type ToolSummary = ToolDTO;

type FormKind = 'http' | 'shell';

type FormState = {
  slug: string;
  name: string;
  description: string;
  kind: FormKind;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headersJson: string; // JSON object — header → value template
  queryJson: string; // JSON object — query key → value template
  bodyTemplate: string;
  cmd: string;
  inputSchemaJson: string;
  requiresConfirm: boolean;
  enabled: boolean;
};

const emptyForm = (): FormState => ({
  slug: '',
  name: '',
  description: '',
  kind: 'http',
  url: '',
  method: 'POST',
  headersJson: '',
  queryJson: '',
  bodyTemplate: '',
  cmd: '',
  inputSchemaJson: '{\n  "type": "object",\n  "properties": {}\n}',
  requiresConfirm: false,
  enabled: true,
});

function fromTool(t: ToolSummary): FormState {
  const http = t.handler.kind === 'http' ? t.handler : null;
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    kind: t.handler.kind === 'shell' ? 'shell' : 'http',
    url: http?.url ?? '',
    method: http?.method ?? 'POST',
    headersJson: http?.headers ? JSON.stringify(http.headers, null, 2) : '',
    queryJson: http?.query ? JSON.stringify(http.query, null, 2) : '',
    bodyTemplate: http?.body ?? '',
    cmd: t.handler.kind === 'shell' ? t.handler.cmd : '',
    inputSchemaJson: JSON.stringify(t.inputSchema ?? {}, null, 2),
    requiresConfirm: t.requiresConfirm,
    enabled: t.enabled,
  };
}

/** Parse an optional JSON-object textarea; '' → undefined; throws on junk. */
function parseRecordField(label: string, raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`${label}.${k} must be a string`);
    out[k] = v;
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const DEFAULT_SETTINGS: ToolSettings = { requireApproval: false, egressGate: false };

export function ToolsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();

  // ── Reads ─────────────────────────────────────────────────────────────────
  const toolsQuery = useQuery({
    queryKey: ['tools'],
    queryFn: () => apiFetch<{ tools: ToolSummary[] }>('/api/tools').then((r) => r.tools),
  });
  const settingsQuery = useQuery({
    queryKey: ['tools', 'settings'],
    queryFn: () => apiFetch<ToolSettings>('/api/tools/settings'),
  });
  const tools = toolsQuery.data ?? [];
  const settings = settingsQuery.data ?? DEFAULT_SETTINGS;

  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; tool: ToolSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ToolSummary | null>(null);

  // ── Mutations ───────────────────────────────────────────────────────────────
  // Settings toggles — optimistic: flip the cached value immediately, roll back
  // on error. (Replaces the old useState + server action + manual rollback.)
  const settingsMutation = useMutation({
    mutationFn: (patch: Partial<ToolSettings>) =>
      apiSend<ToolSettings>('/api/tools/settings', 'PUT', patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['tools', 'settings'] });
      const prev = queryClient.getQueryData<ToolSettings>(['tools', 'settings']);
      queryClient.setQueryData<ToolSettings>(['tools', 'settings'], (old) => ({
        ...(old ?? DEFAULT_SETTINGS),
        ...patch,
      }));
      return { prev };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['tools', 'settings'], ctx.prev);
      toast.error('Could not save that setting');
    },
    onSuccess: (data) => queryClient.setQueryData(['tools', 'settings'], data),
  });

  const toggleRequireApproval = (next: boolean) =>
    settingsMutation.mutate(
      { requireApproval: next },
      {
        onSuccess: () =>
          toast.success(
            next
              ? 'Agent-built tools will now require your approval'
              : 'Agent-built tools no longer require approval',
          ),
      },
    );
  const toggleEgressGate = (next: boolean) =>
    settingsMutation.mutate(
      { egressGate: next },
      {
        onSuccess: () =>
          toast.success(
            next
              ? 'Unattended heartbeats will now park email/web for approval'
              : 'Unattended heartbeats run email/web inline again',
          ),
      },
    );

  const saveMutation = useMutation({
    mutationFn: (vars: {
      mode: 'create' | 'edit';
      id?: string;
      body: Record<string, unknown>;
    }) =>
      vars.mode === 'create'
        ? apiSend('/api/tools', 'POST', vars.body)
        : apiSend(`/api/tools/${vars.id}`, 'PATCH', vars.body),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['tools'] });
      setEditing(null);
      toast.success(vars.mode === 'create' ? 'Tool created' : 'Tool saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend(`/api/tools/${id}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['tools'] });
      if (editing?.mode === 'edit' && editing.tool.id === id) setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed.'),
  });

  const builtins = tools.filter((t) => t.handler.kind === 'builtin');
  const userDefined = tools.filter((t) => t.handler.kind !== 'builtin');

  const editTool = editing?.mode === 'edit' ? editing.tool : null;
  const isBuiltin = editTool?.handler.kind === 'builtin';
  const isRecipe = editTool?.handler.kind === 'recipe';
  // Recipe + builtin handlers aren't editable via this form (a recipe is a
  // step chain authored by the Toolsmith — delete + recreate to change it);
  // only Enabled / Requires-confirm toggle. Recipes stay deletable (they're
  // user-defined), so the Delete button keys off !isBuiltin, not !isReadOnly.
  const isReadOnly = isBuiltin || isRecipe;
  const selectedId = editTool?.id ?? null;
  const settingsBusy = settingsQuery.isPending || settingsMutation.isPending;

  const openCreate = () => {
    setForm(emptyForm());
    setSlugTouched(false);
    setEditing({ mode: 'create' });
  };
  const openEdit = (t: ToolSummary) => {
    setForm(fromTool(t));
    setSlugTouched(true);
    setEditing({ mode: 'edit', tool: t });
  };
  const close = () => setEditing(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;

    // Built-in: only the editable metadata is sent (handler/slug/schema are
    // code-backed and immutable). Everything else uses the full body.
    let body: Record<string, unknown>;
    if (
      editing.mode === 'edit' &&
      (editing.tool.handler.kind === 'builtin' || editing.tool.handler.kind === 'recipe')
    ) {
      body = {
        requiresConfirm: form.requiresConfirm,
        enabled: form.enabled,
      };
    } else {
      let inputSchema: Record<string, unknown>;
      try {
        inputSchema = JSON.parse(form.inputSchemaJson);
      } catch {
        toast.error('Input schema is not valid JSON.');
        return;
      }
      let handler: ToolHandler;
      if (form.kind === 'shell') {
        handler = { kind: 'shell', cmd: form.cmd };
      } else {
        let headers: Record<string, string> | undefined;
        let query: Record<string, string> | undefined;
        try {
          headers = parseRecordField('Headers', form.headersJson);
          query = parseRecordField('Query', form.queryJson);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Headers/Query must be JSON objects.');
          return;
        }
        // Preserve handler fields that have no form input (e.g. timeoutMs set
        // via the API/Toolsmith) — the PATCH replaces the whole handler jsonb,
        // so an unmapped field would be silently dropped on save.
        const priorHttp =
          editing.mode === 'edit' && editing.tool.handler.kind === 'http'
            ? editing.tool.handler
            : null;
        handler = {
          kind: 'http',
          url: form.url,
          method: form.method,
          ...(headers ? { headers } : {}),
          ...(query ? { query } : {}),
          ...(form.bodyTemplate.trim() ? { body: form.bodyTemplate } : {}),
          ...(priorHttp?.timeoutMs !== undefined ? { timeoutMs: priorHttp.timeoutMs } : {}),
        };
      }
      body = {
        name: form.name.trim(),
        description: form.description.trim(),
        inputSchema,
        handler,
        requiresConfirm: form.requiresConfirm,
        enabled: form.enabled,
        ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
      };
    }

    saveMutation.mutate(
      editing.mode === 'create'
        ? { mode: 'create', body }
        : { mode: 'edit', id: editing.tool.id, body },
    );
  };

  const confirmDelete = () => {
    const t = deleteTarget;
    if (!t) return;
    setDeleteTarget(null);
    deleteMutation.mutate(t.id, { onSuccess: () => toast.success(`Deleted ${t.slug}`) });
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: tool list ──────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-4 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {toolsQuery.isPending ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted-foreground">
              <Spinner size={28} />
              Loading tools…
            </div>
          ) : toolsQuery.isError ? (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
              <p>Couldn’t load tools: {toolsQuery.error.message}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => toolsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <section className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    User-defined ({userDefined.length})
                  </h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={openCreate}
                  >
                    <Plus /> New
                  </Button>
                </div>
                {userDefined.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground/60">None yet.</p>
                ) : (
                  userDefined.map((t) => (
                    <ToolCard key={t.id} tool={t} selected={selectedId === t.id} onClick={() => openEdit(t)} />
                  ))
                )}
              </section>

              <section className="space-y-1.5">
                <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Built-in ({builtins.length})
                </h3>
                {builtins.map((t) => (
                  <ToolCard key={t.id} tool={t} selected={selectedId === t.id} onClick={() => openEdit(t)} />
                ))}
              </section>
            </>
          )}

          {settingsQuery.isError && (
            <p className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Couldn’t load tool policy settings — showing defaults.
              <button
                type="button"
                onClick={() => settingsQuery.refetch()}
                className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
              >
                Retry
              </button>
            </p>
          )}

          <section className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="require-approval" className="text-xs font-medium">
                  Require my approval for agent-built tools
                </Label>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  When on, a tool an agent builds (via Toolsmith) parks each call for your approval
                  until you clear <span className="font-medium">requires confirm</span> for it. Turn
                  on if an agent that reads email or the web can author tools.
                </p>
              </div>
              <Switch
                id="require-approval"
                checked={settings.requireApproval}
                disabled={settingsBusy}
                onCheckedChange={toggleRequireApproval}
                className="mt-0.5 shrink-0"
              />
            </div>
          </section>

          <section className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="egress-gate" className="text-xs font-medium">
                  Approve email &amp; web during unattended heartbeats
                </Label>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  When on, a heartbeat that fires while you&apos;re away parks any{' '}
                  <span className="font-medium">email or web</span> call for your approval instead of
                  running it inline. You can clear it from the Telegram card on your phone. The
                  heartbeat&apos;s own message reply is unaffected.
                </p>
              </div>
              <Switch
                id="egress-gate"
                checked={settings.egressGate}
                disabled={settingsBusy}
                onCheckedChange={toggleEgressGate}
                className="mt-0.5 shrink-0"
              />
            </div>
          </section>
        </div>
      </div>

      {/* ── Right: editor ────────────────────────────────────────── */}
      {/* `relative` keeps the tall scrolling content from leaking into <main>'s
          own scroll area (a second, outer scrollbar). See agents-client. */}
      <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {!editing ? (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a tool to view or edit, or create a new one.
          </div>
        ) : (
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">
                  {editing.mode === 'create' ? 'New tool' : editing.tool.slug}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {isBuiltin
                    ? 'Built-in (code-backed). Name, description, and schema are defined in code (read-only) — toggle Enabled and Requires-confirm here.'
                    : isRecipe
                      ? 'Recipe (a chain of existing tools, authored by the Toolsmith). Read-only here — delete and recreate to change the steps; toggle Enabled and Requires-confirm.'
                      : editing.mode === 'create'
                        ? 'A new HTTP or shell tool. Slug is immutable after creation.'
                        : 'Update the tool. Slug + kind are immutable.'}
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
                {editing.mode === 'edit' && !isBuiltin && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(editing.tool)}
                  >
                    <Trash2 /> Delete
                  </Button>
                )}
              </div>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        name: e.target.value,
                        slug: slugTouched ? f.slug : slugify(e.target.value),
                      }))
                    }
                    required
                    autoFocus
                    disabled={isReadOnly}
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
                    disabled={editing.mode === 'edit'}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">Description (the model reads this)</Label>
                <Input
                  id="description"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What this tool does, when to use it"
                  required
                  disabled={isReadOnly}
                />
              </div>

              {isReadOnly && editTool ? (
                <div className="space-y-1.5">
                  <Label>Handler</Label>
                  {editTool.handler.kind === 'recipe' ? (
                    <>
                      <div className="space-y-1 rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs">
                        {editTool.handler.steps.map((s, i) => (
                          <div key={i} className="truncate">
                            <span className="text-muted-foreground">{i}.</span> {s.tool}
                            {s.as ? <span className="text-muted-foreground"> → ${s.as}</span> : null}
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        A chain of {editTool.handler.steps.length} existing tools; data flows between
                        steps server-side. Delete and recreate via the Toolsmith to change it.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs">
                        builtin · {editTool.handler.kind === 'builtin' ? editTool.handler.ref : ''}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Code-backed; the implementation is fixed. Edit it in{' '}
                        <code>packages/tools/src/builtins*.ts</code>.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="kind">Kind</Label>
                    <select
                      id="kind"
                      value={form.kind}
                      onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as FormKind }))}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      disabled={editing.mode === 'edit'}
                    >
                      <option value="http">HTTP — fire a request</option>
                      <option value="shell">Shell — run a command (auto-confirms required)</option>
                    </select>
                  </div>

                  {form.kind === 'http' ? (
                    <>
                      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                        <div className="space-y-1.5">
                          <Label htmlFor="url">URL template</Label>
                          <Input
                            id="url"
                            value={form.url}
                            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                            placeholder="https://api.example.com/route/{origin}/{destination}"
                            required
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="method">Method</Label>
                          <select
                            id="method"
                            value={form.method}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, method: e.target.value as FormState['method'] }))
                            }
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          >
                            <option>GET</option>
                            <option>POST</option>
                            <option>PUT</option>
                            <option>PATCH</option>
                            <option>DELETE</option>
                          </select>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="http-headers">Headers (JSON object, optional)</Label>
                          <textarea
                            id="http-headers"
                            value={form.headersJson}
                            onChange={(e) => setForm((f) => ({ ...f, headersJson: e.target.value }))}
                            rows={3}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                            placeholder={'{\n  "authorization": "Bearer {{secret:mapbox/default}}"\n}'}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="http-query">Query params (JSON object, optional)</Label>
                          <textarea
                            id="http-query"
                            value={form.queryJson}
                            onChange={(e) => setForm((f) => ({ ...f, queryJson: e.target.value }))}
                            rows={3}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                            placeholder={'{\n  "access_token": "{{secret:mapbox/default}}"\n}'}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="http-body">Body template (optional)</Label>
                        <textarea
                          id="http-body"
                          value={form.bodyTemplate}
                          onChange={(e) => setForm((f) => ({ ...f, bodyTemplate: e.target.value }))}
                          rows={3}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                          placeholder={'{"query": {q}, "limit": {limit}}'}
                        />
                        <p className="text-xs text-muted-foreground">
                          <code>{'{param}'}</code> placeholders fill from the model&apos;s input
                          (URL-encoded in the URL, JSON-encoded in the body);{' '}
                          <code>{'{{secret:service/label}}'}</code> pulls from the API-key vault at
                          call time. No body template → non-GET calls send the whole input as JSON.
                          Tip: the API Console (System → API Console) builds these visually.
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-1.5">
                      <Label htmlFor="cmd">Command template</Label>
                      <textarea
                        id="cmd"
                        value={form.cmd}
                        onChange={(e) => setForm((f) => ({ ...f, cmd: e.target.value }))}
                        rows={3}
                        required
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                        placeholder={'echo "hello ${input.name}"'}
                      />
                      <p className="text-xs text-muted-foreground">
                        Use <code>{'${input.<field>}'}</code> placeholders. Values are shell-escaped
                        before substitution. 30s timeout, 10KB output cap.
                      </p>
                    </div>
                  )}
                </>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="schema">Input schema (JSON Schema)</Label>
                <textarea
                  id="schema"
                  value={form.inputSchemaJson}
                  onChange={(e) => setForm((f) => ({ ...f, inputSchemaJson: e.target.value }))}
                  rows={isReadOnly ? 10 : 6}
                  readOnly={isReadOnly}
                  className={cn(
                    'w-full rounded-md border border-input px-3 py-2 text-sm font-mono',
                    isReadOnly ? 'bg-muted/40 text-muted-foreground' : 'bg-background',
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {isReadOnly
                    ? 'What the model passes to this tool (read-only).'
                    : 'Sent verbatim to the model so it knows what to pass.'}
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.requiresConfirm}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, requiresConfirm: v }))}
                />
                Requires operator confirm
              </label>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <SubmitButton pending={saveMutation.isPending}>
                  {editing.mode === 'create' ? 'Create tool' : 'Save tool'}
                </SubmitButton>
              </div>
            </form>
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.slug}”?</AlertDialogTitle>
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

function ToolCard({
  tool,
  selected,
  onClick,
}: {
  tool: ToolSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
        selected && 'border-l-primary',
        !tool.enabled && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        <code className="truncate font-mono text-sm font-medium">{tool.slug}</code>
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {tool.handler.kind}
        </span>
        {!tool.enabled && (
          <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            off
          </span>
        )}
        {tool.requiresConfirm && (
          <span
            className="shrink-0 rounded-sm bg-destructive/15 px-1 text-[10px] uppercase tracking-wider text-destructive"
            title="Requires operator confirm"
          >
            confirm
          </span>
        )}
      </div>
      {tool.description && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>
      )}
    </button>
  );
}
