'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import type { ToolDTO, ToolGroupWithRefs } from '@mantle/client-types';
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
import { ToolPicker, type ToolOption } from '@/components/tool-picker';
import { cn } from '@/lib/utils';
import { slugify } from '@/lib/slugify';

// List items carry the agent-grant fan-out from GET /api/tool-groups.
type ToolGroupSummary = ToolGroupWithRefs;

type FormState = {
  slug: string;
  name: string;
  description: string;
  toolSlugs: string[];
  enabled: boolean;
};

const emptyForm = (): FormState => ({
  slug: '',
  name: '',
  description: '',
  toolSlugs: [],
  enabled: true,
});

function fromGroup(g: ToolGroupSummary): FormState {
  return {
    slug: g.slug,
    name: g.name,
    description: g.description,
    toolSlugs: g.toolSlugs,
    enabled: g.enabled,
  };
}

export function ToolGroupsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();

  // ── Reads ─────────────────────────────────────────────────────────────────
  const groupsQuery = useQuery({
    queryKey: ['tool-groups'],
    queryFn: () =>
      apiFetch<{ groups: ToolGroupSummary[] }>('/api/tool-groups').then((r) => r.groups),
  });
  // Shares the ['tools'] cache with /settings/tools — projected to the picker shape.
  const toolsQuery = useQuery({
    queryKey: ['tools'],
    queryFn: () => apiFetch<{ tools: ToolDTO[] }>('/api/tools').then((r) => r.tools),
  });
  const groups = groupsQuery.data ?? [];
  const availableTools: ToolOption[] = useMemo(
    () =>
      (toolsQuery.data ?? []).map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        requiresConfirm: t.requiresConfirm,
        kind: t.handler.kind,
      })),
    [toolsQuery.data],
  );

  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; group: ToolGroupSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ToolGroupSummary | null>(null);

  // ── Mutations ───────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (vars: { mode: 'create' | 'edit'; id?: string; body: Record<string, unknown> }) =>
      vars.mode === 'create'
        ? apiSend('/api/tool-groups', 'POST', vars.body)
        : apiSend(`/api/tool-groups/${vars.id}`, 'PATCH', vars.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tool-groups'] });
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'save failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend(`/api/tool-groups/${id}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['tool-groups'] });
      if (editing?.mode === 'edit' && editing.group.id === id) setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed.'),
  });

  const onName = (v: string) =>
    setForm((f) => ({
      ...f,
      name: v,
      slug: slugTouched ? f.slug : slugify(v, { allowUnderscore: true, maxLength: 64 }),
    }));

  const openCreate = () => {
    setForm(emptyForm());
    setSlugTouched(false);
    setEditing({ mode: 'create' });
  };
  const openEdit = (g: ToolGroupSummary) => {
    setForm(fromGroup(g));
    setSlugTouched(true);
    setEditing({ mode: 'edit', group: g });
  };
  const close = () => setEditing(null);

  // Deep link: /settings/tool-groups?selected=<id-or-slug> opens that group's
  // editor once the list arrives (one-shot; selection stays client-state).
  const searchParams = useSearchParams();
  const deepLinkRef = useRef(searchParams.get('selected'));
  useEffect(() => {
    const want = deepLinkRef.current?.trim();
    if (!want || groups.length === 0) return;
    deepLinkRef.current = null;
    const hit = groups.find((g) => g.id === want || g.slug === want);
    if (hit) openEdit(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      toolSlugs: form.toolSlugs,
      enabled: form.enabled,
      ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
    };
    saveMutation.mutate(
      editing.mode === 'create'
        ? { mode: 'create', body }
        : { mode: 'edit', id: editing.group.id, body },
    );
  };

  const confirmDelete = () => {
    const g = deleteTarget;
    if (!g) return;
    setDeleteTarget(null);
    deleteMutation.mutate(g.id, { onSuccess: () => toast.success(`Deleted ${g.name}`) });
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: group list ─────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Tool groups
          </h2>
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {groupsQuery.isPending ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted-foreground">
              <Spinner size={28} />
              Loading tool groups…
            </div>
          ) : groupsQuery.isError ? (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
              <p>Couldn’t load tool groups: {groupsQuery.error.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => groupsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No tool groups yet. Click <strong>New</strong> to bundle some tools.
            </p>
          ) : (
            groups.map((g) => {
              const selected = editing?.mode === 'edit' && editing.group.id === g.id;
              const agents = g.grantedTo ?? [];
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => openEdit(g)}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    selected && 'border-l-primary',
                    !g.enabled && 'opacity-70',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{g.name}</span>
                    <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {g.toolSlugs.length} tool{g.toolSlugs.length === 1 ? '' : 's'}
                    </span>
                    {!g.enabled && (
                      <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        off
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {g.slug}
                  </div>
                  {g.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {g.description}
                    </p>
                  )}
                  {agents.length > 0 && (
                    <div
                      className="mt-1 text-xs text-sky-700 dark:text-sky-300"
                      title={agents.join('\n')}
                    >
                      ↳ granted to {agents.length} agent{agents.length === 1 ? '' : 's'}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right: editor ────────────────────────────────────────── */}
      {/* `relative` keeps the tall scrolling content from leaking into <main>'s
          own scroll area (a second, outer scrollbar). See agents-client. */}
      <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {editing ? (
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">
                  {editing.mode === 'create' ? 'New tool group' : `Edit ${editing.group.name}`}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {editing.mode === 'create'
                    ? 'A named bundle of tools. Slug is immutable after creation.'
                    : 'Update the bundle. Slug is immutable.'}
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
                    onClick={() => setDeleteTarget(editing.group)}
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
                    onChange={(e) => onName(e.target.value)}
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
                <Label htmlFor="description">Description (what this bundle is for)</Label>
                <Input
                  id="description"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Calendar — event CRUD"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Tools in this group</Label>
                {toolsQuery.isError ? (
                  <p className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                    Couldn’t load the tool list.
                    <button
                      type="button"
                      onClick={() => toolsQuery.refetch()}
                      className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
                    >
                      Retry
                    </button>
                  </p>
                ) : toolsQuery.isPending ? (
                  <p className="text-xs text-muted-foreground">Loading tools…</p>
                ) : availableTools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No tools registered yet. Start <code>pnpm dev</code> to seed built-ins.
                  </p>
                ) : (
                  <ToolPicker
                    available={availableTools}
                    selected={form.toolSlugs}
                    onChange={(next) => setForm((f) => ({ ...f, toolSlugs: next }))}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  When an agent is granted this group, every tool here joins its effective tool set.
                  Capability only — no instructions (that&apos;s what skills are for).
                </p>
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <SubmitButton pending={saveMutation.isPending}>
                  {editing.mode === 'create' ? 'Create group' : 'Save group'}
                </SubmitButton>
              </div>
            </form>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a tool group to edit, or create a new one.
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const refs = deleteTarget?.grantedTo ?? [];
                if (refs.length === 0) return 'This cannot be undone.';
                return `Granted to ${refs.length} agent${refs.length === 1 ? '' : 's'} (${refs.join(', ')}) — the grant will be removed from ${refs.length === 1 ? 'it' : 'them'}. This cannot be undone.`;
              })()}
            </AlertDialogDescription>
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
