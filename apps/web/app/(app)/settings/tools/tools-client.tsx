'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
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

type ToolHandlerBuiltin = { kind: 'builtin'; ref: string };
type ToolHandlerHttp = {
  kind: 'http';
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headersRef?: string | null;
  authRef?: string | null;
  timeoutMs?: number;
};
type ToolHandlerShell = { kind: 'shell'; cmd: string };
type ToolHandler = ToolHandlerBuiltin | ToolHandlerHttp | ToolHandlerShell;

type ToolSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  requiresConfirm: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type FormKind = 'http' | 'shell';

type FormState = {
  slug: string;
  name: string;
  description: string;
  kind: FormKind;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
  cmd: '',
  inputSchemaJson: '{\n  "type": "object",\n  "properties": {}\n}',
  requiresConfirm: false,
  enabled: true,
});

function fromTool(t: ToolSummary): FormState {
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    kind: t.handler.kind === 'shell' ? 'shell' : 'http',
    url: t.handler.kind === 'http' ? t.handler.url : '',
    method: t.handler.kind === 'http' ? (t.handler.method ?? 'POST') : 'POST',
    cmd: t.handler.kind === 'shell' ? t.handler.cmd : '',
    inputSchemaJson: JSON.stringify(t.inputSchema ?? {}, null, 2),
    requiresConfirm: t.requiresConfirm,
    enabled: t.enabled,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function ToolsClient({ initialTools }: { initialTools: ToolSummary[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tools, setTools] = useState<ToolSummary[]>(initialTools);
  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; tool: ToolSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ToolSummary | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => setTools(initialTools), [initialTools]);

  const builtins = tools.filter((t) => t.handler.kind === 'builtin');
  const userDefined = tools.filter((t) => t.handler.kind !== 'builtin');

  const editTool = editing?.mode === 'edit' ? editing.tool : null;
  const isBuiltin = editTool?.handler.kind === 'builtin';
  const selectedId = editTool?.id ?? null;

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;

    // Built-in: only the editable metadata is sent (handler/slug/schema
    // are code-backed and immutable). Everything else uses the full body.
    let body: Record<string, unknown>;
    if (editing.mode === 'edit' && editing.tool.handler.kind === 'builtin') {
      // Built-in name/description/schema/handler are code-defined (re-applied
      // by the seed on boot) — only confirm + enabled persist here.
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
      const handler: ToolHandler =
        form.kind === 'shell'
          ? { kind: 'shell', cmd: form.cmd }
          : { kind: 'http', url: form.url, method: form.method };
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

    const url = editing.mode === 'create' ? '/api/tools' : `/api/tools/${editing.tool.id}`;
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
    toast.success(editing.mode === 'create' ? 'Tool created' : 'Tool saved');
    close();
    startTransition(() => router.refresh());
  };

  const confirmDelete = async () => {
    const t = deleteTarget;
    if (!t) return;
    setDeleteTarget(null);
    if (editing?.mode === 'edit' && editing.tool.id === t.id) close();
    const res = await fetch(`/api/tools/${t.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Delete failed.');
      return;
    }
    toast.success(`Deleted ${t.slug}`);
    setTools((prev) => prev.filter((x) => x.id !== t.id));
    startTransition(() => router.refresh());
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: tool list ──────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-4 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                User-defined ({userDefined.length})
              </h3>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={openCreate}>
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
        </div>
      </div>

      {/* ── Right: editor ────────────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
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
                    disabled={isBuiltin}
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
                  disabled={isBuiltin}
                />
              </div>

              {isBuiltin && editTool ? (
                <div className="space-y-1.5">
                  <Label>Handler</Label>
                  <div className="rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs">
                    builtin · {editTool.handler.kind === 'builtin' ? editTool.handler.ref : ''}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Code-backed; the implementation is fixed. Edit it in{' '}
                    <code>packages/tools/src/builtins*.ts</code>.
                  </p>
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
                    <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                      <div className="space-y-1.5">
                        <Label htmlFor="url">URL</Label>
                        <Input
                          id="url"
                          value={form.url}
                          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                          placeholder="https://your-api.example.com/path"
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
                  rows={isBuiltin ? 10 : 6}
                  readOnly={isBuiltin}
                  className={cn(
                    'w-full rounded-md border border-input px-3 py-2 text-sm font-mono',
                    isBuiltin ? 'bg-muted/40 text-muted-foreground' : 'bg-background',
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {isBuiltin
                    ? 'What the model passes to this built-in (read-only).'
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
                <SubmitButton pending={pending}>
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
            className="shrink-0 rounded-sm bg-rose-500/15 px-1 text-[10px] uppercase tracking-wider text-rose-700 dark:text-rose-300"
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
