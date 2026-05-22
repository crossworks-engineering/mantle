'use client';

import { useEffect, useState, useTransition } from 'react';
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
  const [tools, setTools] = useState<ToolSummary[]>(initialTools);
  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; tool: ToolSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  useEffect(() => setTools(initialTools), [initialTools]);

  const builtins = tools.filter((t) => t.handler.kind === 'builtin');
  const userDefined = tools.filter((t) => t.handler.kind !== 'builtin');

  const openCreate = () => {
    setError(undefined);
    setForm(emptyForm());
    setSlugTouched(false);
    setEditing({ mode: 'create' });
  };
  const openEdit = (t: ToolSummary) => {
    setError(undefined);
    setForm(fromTool(t));
    setSlugTouched(true);
    setEditing({ mode: 'edit', tool: t });
  };
  const close = () => {
    setEditing(null);
    setError(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(undefined);
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = JSON.parse(form.inputSchemaJson);
    } catch {
      setError('input schema is not valid JSON');
      return;
    }
    const handler: ToolHandler =
      form.kind === 'shell'
        ? { kind: 'shell', cmd: form.cmd }
        : { kind: 'http', url: form.url, method: form.method };

    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      inputSchema,
      handler,
      requiresConfirm: form.requiresConfirm,
      enabled: form.enabled,
      ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
    };
    const url = editing.mode === 'create' ? '/api/tools' : `/api/tools/${editing.tool.id}`;
    const method = editing.mode === 'create' ? 'POST' : 'PATCH';
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'save failed');
      return;
    }
    close();
    startTransition(() => router.refresh());
  };

  const onDelete = async (t: ToolSummary) => {
    if (!window.confirm(`Delete tool "${t.slug}"?`)) return;
    const res = await fetch(`/api/tools/${t.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'delete failed');
      return;
    }
    setTools((prev) => prev.filter((x) => x.id !== t.id));
    startTransition(() => router.refresh());
  };

  const onToggle = async (t: ToolSummary) => {
    const res = await fetch(`/api/tools/${t.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !t.enabled }),
    });
    if (!res.ok) return;
    setTools((prev) => prev.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)));
    startTransition(() => router.refresh());
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          User-defined tools ({userDefined.length})
        </h2>
        <Button type="button" onClick={openCreate}>
          New tool
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <ToolList
        rows={userDefined}
        onEdit={openEdit}
        onDelete={onDelete}
        onToggle={onToggle}
        pending={pending}
        editable
      />

      <div className="pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Built-in ({builtins.length})
        </h2>
        <p className="text-xs text-muted-foreground">
          Edit definitions in <code>packages/tools/src/builtins.ts</code> and restart.
          You can still toggle enabled here.
        </p>
      </div>
      <ToolList
        rows={builtins}
        onEdit={openEdit}
        onDelete={onDelete}
        onToggle={onToggle}
        pending={pending}
        editable={false}
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent className="!h-auto !max-h-[90vh] !max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === 'create' ? 'New tool' : `Edit ${editing?.mode === 'edit' ? editing.tool.slug : ''}`}
            </DialogTitle>
            <DialogDescription>
              {editing?.mode === 'create'
                ? 'A new HTTP or shell tool. Slug is immutable.'
                : 'Update the tool. Slug is immutable; builtin fields are read-only.'}
            </DialogDescription>
          </DialogHeader>
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
              <Label htmlFor="description">Description (the model reads this)</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What this tool does, when to use it"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kind">Kind</Label>
              <select
                id="kind"
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as FormKind }))}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={editing?.mode === 'edit'}
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
                  Use <code>{'${input.<field>}'}</code> placeholders. Values are
                  shell-escaped before substitution. 30s timeout, 10KB output cap.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="schema">Input schema (JSON Schema)</Label>
              <textarea
                id="schema"
                value={form.inputSchemaJson}
                onChange={(e) => setForm((f) => ({ ...f, inputSchemaJson: e.target.value }))}
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Sent verbatim to the model so it knows what to pass.
              </p>
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.requiresConfirm}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, requiresConfirm: e.target.checked }))
                  }
                />
                Requires operator confirm
                <span className="text-xs text-muted-foreground">
                  (badge only in v1; full pause/resume in phase 5b)
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                Enabled
              </label>
            </div>

            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" onClick={close}>
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

function ToolList({
  rows,
  onEdit,
  onDelete,
  onToggle,
  pending,
  editable,
}: {
  rows: ToolSummary[];
  onEdit: (t: ToolSummary) => void;
  onDelete: (t: ToolSummary) => void;
  onToggle: (t: ToolSummary) => void;
  pending: boolean;
  editable: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        Nothing here yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((t) => (
        <li key={t.id} className="flex items-start gap-3 px-3 py-3 text-sm">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <code className="font-mono font-medium">{t.slug}</code>
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {t.handler.kind}
              </span>
              {!t.enabled && (
                <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                  disabled
                </span>
              )}
              {t.requiresConfirm && (
                <span className="rounded-sm bg-rose-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
                  requires confirm
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t.description}</p>
            {t.handler.kind === 'http' && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {t.handler.method ?? 'POST'} {t.handler.url}
              </p>
            )}
            {t.handler.kind === 'shell' && (
              <p className="font-mono text-[11px] text-muted-foreground">
                $ {t.handler.cmd}
              </p>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={t.enabled}
              onChange={() => onToggle(t)}
              disabled={pending}
              className="size-3.5"
            />
            enabled
          </label>
          {editable && (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(t)}>
                <Pencil /> Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDelete(t)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 /> Delete
              </Button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
