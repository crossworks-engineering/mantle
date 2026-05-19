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

type ToolOption = {
  slug: string;
  name: string;
  description: string;
  requiresConfirm: boolean;
  kind: string;
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

export function SkillsClient({
  initialSkills,
  availableTools,
}: {
  initialSkills: SkillSummary[];
  availableTools: ToolOption[];
}) {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillSummary[]>(initialSkills);
  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; skill: SkillSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  useEffect(() => setSkills(initialSkills), [initialSkills]);

  const onName = (v: string) =>
    setForm((f) => ({ ...f, name: v, slug: slugTouched ? f.slug : slugify(v) }));

  const openCreate = () => {
    setError(undefined);
    setForm(emptyForm());
    setSlugTouched(false);
    setEditing({ mode: 'create' });
  };
  const openEdit = (s: SkillSummary) => {
    setError(undefined);
    setForm(fromSkill(s));
    setSlugTouched(true);
    setEditing({ mode: 'edit', skill: s });
  };
  const close = () => {
    setEditing(null);
    setError(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(undefined);
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
          setError('Default state must be a JSON object (e.g. {"answered": []}).');
          return;
        }
        defaultState = parsed as Record<string, unknown>;
      } catch (err) {
        setError(`Default state JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
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
      setError(b.error ?? 'save failed');
      return;
    }
    close();
    startTransition(() => router.refresh());
  };

  const onDelete = async (s: SkillSummary) => {
    if (!window.confirm(`Delete skill "${s.name}"?`)) return;
    const res = await fetch(`/api/skills/${s.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'delete failed');
      return;
    }
    setSkills((prev) => prev.filter((x) => x.id !== s.id));
    startTransition(() => router.refresh());
  };

  const onToggle = async (s: SkillSummary) => {
    const res = await fetch(`/api/skills/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    if (!res.ok) return;
    setSkills((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    startTransition(() => router.refresh());
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Configured skills
        </h2>
        <Button type="button" onClick={openCreate}>
          New skill
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {skills.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No skills yet. Click <strong>New skill</strong> to author one.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {skills.map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-3 py-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">/ {s.slug}</span>
                  {!s.enabled && (
                    <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                      disabled
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{s.description}</p>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  {s.toolSlugs.length > 0 ? (
                    s.toolSlugs.map((t) => (
                      <code key={t} className="rounded bg-muted px-1 font-mono">
                        {t}
                      </code>
                    ))
                  ) : (
                    <span className="italic">no tools</span>
                  )}
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={() => onToggle(s)}
                  disabled={pending}
                  className="size-3.5"
                />
                enabled
              </label>
              <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(s)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDelete(s)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent className="!h-auto !max-h-[90vh] !max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === 'create' ? 'New skill' : `Edit ${editing?.mode === 'edit' ? editing.skill.name : ''}`}
            </DialogTitle>
            <DialogDescription>
              {editing?.mode === 'create'
                ? 'A new skill. Slug is immutable after creation.'
                : 'Update the skill. Slug is immutable.'}
            </DialogDescription>
          </DialogHeader>
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
                <div className="flex flex-wrap gap-1.5">
                  {availableTools.map((t) => {
                    const on = form.toolSlugs.includes(t.slug);
                    return (
                      <button
                        key={t.slug}
                        type="button"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            toolSlugs: on
                              ? f.toolSlugs.filter((s) => s !== t.slug)
                              : [...f.toolSlugs, t.slug],
                          }))
                        }
                        title={t.description}
                        className={
                          'rounded-full border px-2.5 py-0.5 text-xs font-mono transition ' +
                          (on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-background text-muted-foreground hover:border-muted-foreground/50')
                        }
                      >
                        {t.slug}
                      </button>
                    );
                  })}
                </div>
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
