'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import type { SkillDTO, SkillBackrefs } from '@mantle/client-types';
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
import { slugify } from '@/lib/slugify';

// Row + backref shapes come from the shared client-types package (the wire
// contract), so this screen never imports @mantle/db just to name them.
type SkillSummary = SkillDTO;

type FormState = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  /** Free-form JSON the skill author types. Validated on submit;
   *  parsed value stored on the row. Empty string = default to `{}`. */
  defaultStateText: string;
  enabled: boolean;
};

const emptyForm = (): FormState => ({
  slug: '',
  name: '',
  description: '',
  instructions: '',
  defaultStateText: '{}',
  enabled: true,
});

function fromSkill(s: SkillSummary): FormState {
  return {
    slug: s.slug,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    defaultStateText: JSON.stringify(s.defaultState ?? {}, null, 2),
    enabled: s.enabled,
  };
}

export function SkillsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();

  // ── Reads (TanStack Query) ────────────────────────────────────────────────
  // Query keys mirror the URL; invalidating ['skills'] re-validates both the
  // list and its backrefs (prefix match) — the client-side replacement for the
  // server's revalidatePath.
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => apiFetch<{ skills: SkillSummary[] }>('/api/skills').then((r) => r.skills),
  });
  const backrefsQuery = useQuery({
    queryKey: ['skills', 'backrefs'],
    queryFn: () =>
      apiFetch<{ backrefs: SkillBackrefs }>('/api/skills/backrefs').then((r) => r.backrefs),
  });
  const skills = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);
  const heartbeatBackrefs = backrefsQuery.data ?? {};

  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; skill: SkillSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (vars: { mode: 'create' | 'edit'; id?: string; body: Record<string, unknown> }) =>
      vars.mode === 'create'
        ? apiSend('/api/skills', 'POST', vars.body)
        : apiSend(`/api/skills/${vars.id}`, 'PATCH', vars.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'save failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend(`/api/skills/${id}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      if (editing?.mode === 'edit' && editing.skill.id === id) setEditing(null);
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
  const openEdit = (s: SkillSummary) => {
    setForm(fromSkill(s));
    setSlugTouched(true);
    setEditing({ mode: 'edit', skill: s });
  };
  const close = () => setEditing(null);

  // Deep link: /settings/skills?selected=<id-or-slug> opens that skill's
  // editor once the list arrives (one-shot; selection stays client-state).
  const searchParams = useSearchParams();
  const deepLinkRef = useRef(searchParams.get('selected'));
  useEffect(() => {
    const want = deepLinkRef.current?.trim();
    if (!want || skills.length === 0) return;
    deepLinkRef.current = null;
    const hit = skills.find((s) => s.id === want || s.slug === want);
    if (hit) openEdit(hit);
  }, [skills]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    // Parse + validate the default_state JSON before sending. Empty textarea or
    // whitespace defaults to {}; any other input must parse as a JSON object
    // (not array, not primitive). Surfaces errors inline.
    let defaultState: Record<string, unknown> = {};
    const raw = form.defaultStateText.trim();
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          toast.error('Default state must be a JSON object (e.g. {"answered": []}).');
          return;
        }
        defaultState = parsed as Record<string, unknown>;
      } catch (err) {
        toast.error(
          `Default state JSON is invalid: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions,
      defaultState,
      enabled: form.enabled,
      ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
    };
    saveMutation.mutate(
      editing.mode === 'create'
        ? { mode: 'create', body }
        : { mode: 'edit', id: editing.skill.id, body },
    );
  };

  const confirmDelete = () => {
    const s = deleteTarget;
    if (!s) return;
    setDeleteTarget(null);
    deleteMutation.mutate(s.id, {
      onSuccess: () => toast.success(`Deleted ${s.name}`),
    });
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: skill list ─────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Skills
          </h2>
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {/* Subtle, non-blocking notice: the list still works without the
              heartbeat-usage badges if their fetch fails. */}
          {backrefsQuery.isError && (
            <p className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Couldn’t load heartbeat usage — badges hidden.
              <button
                type="button"
                onClick={() => backrefsQuery.refetch()}
                className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
              >
                Retry
              </button>
            </p>
          )}
          {skillsQuery.isPending ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted-foreground">
              <Spinner size={28} />
              Loading skills…
            </div>
          ) : skillsQuery.isError ? (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
              <p>Couldn’t load skills: {skillsQuery.error.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => skillsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : skills.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No skills yet. Click <strong>New</strong> to author one.
            </p>
          ) : (
            skills.map((s) => {
              const selected = editing?.mode === 'edit' && editing.skill.id === s.id;
              const refs = heartbeatBackrefs[s.slug] ?? [];
              const activeRefs = refs.filter((r) => r.status === 'active').length;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => openEdit(s)}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    selected && 'border-l-primary',
                    !s.enabled && 'opacity-70',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {!s.enabled && (
                      <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        off
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {s.slug}
                  </div>
                  {s.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {s.description}
                    </p>
                  )}
                  {refs.length > 0 && (
                    <div
                      className="mt-1 text-xs text-sky-700 dark:text-sky-300"
                      title={refs.map((r) => `${r.slug} [${r.status}]`).join('\n')}
                    >
                      ↳{' '}
                      {activeRefs > 0
                        ? `${activeRefs}/${refs.length} heartbeats active`
                        : `${refs.length} heartbeats`}
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
                  {editing.mode === 'create' ? 'New skill' : `Edit ${editing.skill.name}`}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {editing.mode === 'create'
                    ? 'A new skill. Slug is immutable after creation.'
                    : 'Update the skill. Slug is immutable.'}
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
                    onClick={() => setDeleteTarget(editing.skill)}
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
                <Label htmlFor="description">
                  Description (1 sentence — when to use this skill)
                </Label>
                <Input
                  id="description"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Triage an inbox: classify each email + draft a brief reply"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="instructions">Instructions (markdown)</Label>
                <textarea
                  id="instructions"
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  rows={10}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  placeholder={
                    'Step 1: list pending emails with email_list.\nStep 2: for each, draft a reply with file_create under files/drafts/.\n...'
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Appended verbatim to the system prompt of any agent this skill is attached to.
                  Reference tools by their slug; the agent will see them in its tool list.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="defaultState">
                  Default state (JSON template for heartbeats using this skill)
                </Label>
                <textarea
                  id="defaultState"
                  value={form.defaultStateText}
                  onChange={(e) => setForm((f) => ({ ...f, defaultStateText: e.target.value }))}
                  rows={5}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  placeholder={'{\n  "answered": [],\n  "expecting_reply": false\n}'}
                />
                <p className="text-xs text-muted-foreground">
                  Heartbeats created against this skill copy this as their initial{' '}
                  <code>state</code>. Once a heartbeat exists, its own state is the source of truth
                  — edits here don&apos;t propagate. Leave empty for <code>{'{}'}</code>. See
                  well-known keys in{' '}
                  <a
                    href="https://github.com/TitanKing/mantle/blob/main/docs/heartbeats.md#10-conventions-well-known-state-keys"
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    docs/heartbeats.md §10
                  </a>
                  .
                </p>
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <SubmitButton pending={saveMutation.isPending}>
                  {editing.mode === 'create' ? 'Create skill' : 'Save skill'}
                </SubmitButton>
              </div>
            </form>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a skill to edit, or create a new one.
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const refs = deleteTarget ? (heartbeatBackrefs[deleteTarget.slug] ?? []) : [];
                if (refs.length === 0) return 'This cannot be undone.';
                const active = refs.filter((r) => r.status === 'active').length;
                return `Referenced by ${refs.length} heartbeat${refs.length === 1 ? '' : 's'}${active > 0 ? ` — ${active} active will auto-pause on next fire` : ''}. This cannot be undone.`;
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
