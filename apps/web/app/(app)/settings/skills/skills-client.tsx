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
import { ToolPicker, type ToolOption } from '@/components/tool-picker';
import { cn } from '@/lib/utils';

type SkillSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  toolSlugs: string[];
  /** Template state shape heartbeats inherit. Empty {} by default. */
  defaultState: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type FormState = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  toolSlugs: string[];
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
  toolSlugs: [],
  defaultStateText: '{}',
  enabled: true,
});

function fromSkill(s: SkillSummary): FormState {
  return {
    slug: s.slug,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    toolSlugs: s.toolSlugs,
    defaultStateText: JSON.stringify(s.defaultState ?? {}, null, 2),
    enabled: s.enabled,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Heartbeat back-references per skill slug. Empty array OR missing
 *  key both mean "no heartbeats reference this skill". */
type HeartbeatBackrefs = Record<
  string,
  Array<{ slug: string; name: string; status: string }>
>;

export function SkillsClient({
  initialSkills,
  availableTools,
  heartbeatBackrefs,
}: {
  initialSkills: SkillSummary[];
  availableTools: ToolOption[];
  heartbeatBackrefs: HeartbeatBackrefs;
}) {
  const router = useRouter();
  const toast = useToast();
  const [skills, setSkills] = useState<SkillSummary[]>(initialSkills);
  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; skill: SkillSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => setSkills(initialSkills), [initialSkills]);

  const onName = (v: string) =>
    setForm((f) => ({ ...f, name: v, slug: slugTouched ? f.slug : slugify(v) }));

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
  const close = () => {
    setEditing(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    // Parse + validate the default_state JSON before sending. Empty
    // textarea or whitespace defaults to {}; any other input must
    // parse as a JSON object (not array, not primitive). Surfaces
    // errors inline so the operator can correct without losing the
    // rest of the form.
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
        toast.error(`Default state JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions,
      toolSlugs: form.toolSlugs,
      defaultState,
      enabled: form.enabled,
      ...(editing.mode === 'create' ? { slug: form.slug.trim() } : {}),
    };
    const url = editing.mode === 'create' ? '/api/skills' : `/api/skills/${editing.skill.id}`;
    const method = editing.mode === 'create' ? 'POST' : 'PATCH';
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'save failed');
      return;
    }
    close();
    startTransition(() => router.refresh());
  };

  const confirmDelete = async () => {
    const s = deleteTarget;
    if (!s) return;
    setDeleteTarget(null);
    if (editing?.mode === 'edit' && editing.skill.id === s.id) close();
    const res = await fetch(`/api/skills/${s.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Delete failed.');
      return;
    }
    toast.success(`Deleted ${s.name}`);
    setSkills((prev) => prev.filter((x) => x.id !== s.id));
    startTransition(() => router.refresh());
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
          {skills.length === 0 ? (
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
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
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
              <Label htmlFor="description">Description (1 sentence — when to use this skill)</Label>
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
                placeholder={'Step 1: list pending emails with email_list.\nStep 2: for each, draft a reply with file_create under files/drafts/.\n...'}
              />
              <p className="text-xs text-muted-foreground">
                Appended verbatim to the system prompt of any agent this skill is
                attached to. Reference tools by their slug; the agent will see them
                in its tool list.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Suggested tools (joined into the agent&apos;s allowlist)</Label>
              {availableTools.length === 0 ? (
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
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="defaultState">Default state (JSON template for heartbeats using this skill)</Label>
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
                <code>state</code>. Once a heartbeat exists, its own state is the source
                of truth — edits here don&apos;t propagate. Leave empty for{' '}
                <code>{'{}'}</code>. See well-known keys in{' '}
                <a href="https://github.com/TitanKing/mantle/blob/main/docs/heartbeats.md#10-conventions-well-known-state-keys" className="underline" target="_blank" rel="noreferrer">
                  docs/heartbeats.md §10
                </a>
                .
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <SubmitButton pending={pending}>
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
