'use client';

import { useMemo, useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DateTimePicker } from '@/components/ui/date-time-picker';
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
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import type { HeartbeatDTO, AgentOptionDTO, SkillDTO } from '@mantle/client-types';

type HeartbeatSummary = HeartbeatDTO;

type AgentOpt = { slug: string; name: string; role: string };
type SkillOpt = {
  slug: string;
  name: string;
  /** Template state shape — pre-fills the heartbeat form's `state`
   *  textarea when the operator picks this skill on create. */
  defaultState: Record<string, unknown>;
};

type GatePreset = 'none' | 'sensible' | 'custom';

type FormState = {
  id?: string;
  slug: string;
  name: string;
  description: string;
  agent_slug: string;
  skill_slug: string;
  schedule_kind: 'once' | 'interval' | 'manual';
  schedule_at: string; // datetime-local
  schedule_every_minutes: string;
  schedule_jitter_minutes: string;
  surface_kind: 'telegram' | 'web';
  surface_chat_id: string;
  earliest_at: string;
  max_fires: string;
  gate_preset: GatePreset;
  min_idle_minutes: string;
  quiet_from: string;
  quiet_to: string;
  quiet_tz: string;
  cooldown_minutes: string;
  /** JSON text the operator types/edits. Validated on submit. On
   *  create, pre-filled from the selected skill's defaultState
   *  UNLESS the operator has already touched it. On edit, pre-filled
   *  from heartbeat.state directly. */
  state_text: string;
  /** Tracks whether the operator manually edited the state textarea.
   *  Once true, skill-change no longer overwrites — protects manual
   *  edits from being clobbered when the operator switches skills
   *  back and forth experimentally. */
  state_touched: boolean;
  /** Set when the heartbeat being edited has scheduleKind='cron'.
   *  Cron isn't supported in v1 (see docs/heartbeats.md §2); the
   *  form surfaces a banner + disables the schedule-kind radio in
   *  this case so editing doesn't silently coerce to 'manual'.
   *  P2-4 from the v1 audit. */
  is_cron_locked: boolean;
};

const SENSIBLE_DEFAULTS = {
  min_idle_minutes: '15',
  quiet_from: '22:00',
  quiet_to: '07:00',
  quiet_tz: '',
  cooldown_minutes: '30',
};

function emptyForm(): FormState {
  return {
    slug: '',
    name: '',
    description: '',
    agent_slug: '',
    skill_slug: '',
    schedule_kind: 'interval',
    schedule_at: '',
    schedule_every_minutes: '1440',
    schedule_jitter_minutes: '60',
    surface_kind: 'telegram',
    surface_chat_id: '',
    earliest_at: '',
    max_fires: '',
    gate_preset: 'sensible',
    state_text: '{}',
    state_touched: false,
    is_cron_locked: false,
    ...SENSIBLE_DEFAULTS,
  };
}

function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  // datetime-local needs YYYY-MM-DDTHH:MM (no seconds, no tz).
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromHeartbeat(h: HeartbeatSummary): FormState {
  const surface_chat_id = h.surface.kind === 'telegram' ? h.surface.chat_id : '';
  const isCustomGates = !!(
    h.minIdleMinutes != null ||
    h.quietHours != null ||
    h.cooldownMinutes != null
  );
  return {
    id: h.id,
    slug: h.slug,
    name: h.name,
    description: h.description ?? '',
    agent_slug: h.agentSlug,
    skill_slug: h.skillSlug,
    // Cron rows are surfaced through the form but the schedule_kind
    // radio is locked (see is_cron_locked + banner below). We tag
    // the form state as 'manual' for radio rendering purposes only;
    // the submit path bails before re-serialising the schedule, so
    // the DB row's cron config is preserved unchanged.
    schedule_kind:
      h.scheduleKind === 'cron' ? 'manual' : (h.scheduleKind as FormState['schedule_kind']),
    schedule_at: h.schedule.kind === 'once' ? isoToLocalInput(h.schedule.at) : '',
    schedule_every_minutes: h.schedule.kind === 'interval' ? String(h.schedule.every_minutes) : '',
    schedule_jitter_minutes:
      h.schedule.kind === 'interval' ? String(h.schedule.jitter_minutes ?? '') : '',
    surface_kind: h.surface.kind,
    surface_chat_id,
    earliest_at: isoToLocalInput(h.earliestAt),
    max_fires: h.maxFires != null ? String(h.maxFires) : '',
    gate_preset: isCustomGates ? 'custom' : 'none',
    min_idle_minutes: h.minIdleMinutes != null ? String(h.minIdleMinutes) : '',
    quiet_from: h.quietHours?.from ?? '',
    quiet_to: h.quietHours?.to ?? '',
    quiet_tz: h.quietHours?.tz ?? '',
    cooldown_minutes: h.cooldownMinutes != null ? String(h.cooldownMinutes) : '',
    // On edit, pre-fill from the heartbeat's own state (the source
    // of truth post-creation). state_touched starts true so a
    // subsequent skill change doesn't clobber existing data.
    state_text: JSON.stringify(h.state ?? {}, null, 2),
    state_touched: true,
    is_cron_locked: h.scheduleKind === 'cron',
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function statusBadgeClass(s: HeartbeatSummary['status']): string {
  switch (s) {
    case 'active':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100';
    case 'paused':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100';
    case 'completed':
      return 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100';
    case 'cancelled':
      return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

export function HeartbeatsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();

  // All data is client-fetched against `/api/**` (Phase 2 · Task 4) — no SSR
  // props, so the screen carries no in-process DB read. Mutations invalidate
  // `['heartbeats']` (the client-side replacement for router.refresh()).
  const heartbeatsQuery = useQuery({
    queryKey: ['heartbeats'],
    queryFn: () =>
      apiFetch<{ heartbeats: HeartbeatSummary[] }>('/api/heartbeats').then((r) => r.heartbeats),
  });
  // EVERY agent (incl. worker roles) — heartbeats may bind any of them.
  const agentsQuery = useQuery({
    queryKey: ['agents', 'options'],
    queryFn: () =>
      apiFetch<{ agents: AgentOptionDTO[] }>('/api/agents/options').then((r) => r.agents),
  });
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => apiFetch<{ skills: SkillDTO[] }>('/api/skills').then((r) => r.skills),
  });

  const heartbeats = heartbeatsQuery.data ?? [];
  const agents: AgentOpt[] = agentsQuery.data ?? [];
  const skills = useMemo<SkillOpt[]>(
    () =>
      (skillsQuery.data ?? []).map((s) => ({
        slug: s.slug,
        name: s.name,
        defaultState: (s.defaultState ?? {}) as Record<string, unknown>,
      })),
    [skillsQuery.data],
  );
  const [editing, setEditing] = useState<
    { mode: 'create' } | { mode: 'edit'; hb: HeartbeatSummary } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [slugTouched, setSlugTouched] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HeartbeatSummary | null>(null);
  const [fireTarget, setFireTarget] = useState<HeartbeatSummary | null>(null);
  const [pending, startTransition] = useTransition();

  const openCreate = () => {
    setForm(emptyForm());
    setSlugTouched(false);
    setEditing({ mode: 'create' });
  };
  const openEdit = (hb: HeartbeatSummary) => {
    setForm(fromHeartbeat(hb));
    setSlugTouched(true);
    setEditing({ mode: 'edit', hb });
  };
  const close = () => setEditing(null);

  const onName = (v: string) =>
    setForm((f) => ({ ...f, name: v, slug: slugTouched ? f.slug : slugify(v) }));

  const applyPreset = (preset: GatePreset) =>
    setForm((f) => {
      if (preset === 'sensible') return { ...f, gate_preset: preset, ...SENSIBLE_DEFAULTS };
      if (preset === 'none')
        return {
          ...f,
          gate_preset: preset,
          min_idle_minutes: '',
          quiet_from: '',
          quiet_to: '',
          quiet_tz: '',
          cooldown_minutes: '',
        };
      return { ...f, gate_preset: preset };
    });

  const submit = async () => {
    if (form.is_cron_locked) {
      // Refuse to save while the form holds a cron-locked row.
      // The server action would re-serialise the schedule from
      // form fields, which would lose the cron expression. Force
      // the operator down the documented path (SQL edit or
      // delete + recreate). P2-4 from the v1 audit.
      toast.error(
        'Cannot save: this heartbeat uses a cron schedule (unsupported in v1). Edit via SQL or recreate the row with a v1-supported schedule.',
      );
      return;
    }
    // Build the schedule spec from the radio + its fields.
    let schedule:
      | { kind: 'once'; at: string }
      | { kind: 'interval'; every_minutes: number; jitter_minutes: number }
      | { kind: 'manual' };
    if (form.schedule_kind === 'once') {
      if (!form.schedule_at) {
        toast.error("'once' schedule: pick a date & time.");
        return;
      }
      schedule = { kind: 'once', at: new Date(form.schedule_at).toISOString() };
    } else if (form.schedule_kind === 'interval') {
      const every = Number(form.schedule_every_minutes);
      if (!Number.isFinite(every) || every < 1) {
        toast.error("'interval' schedule: every (minutes) must be ≥ 1.");
        return;
      }
      schedule = {
        kind: 'interval',
        every_minutes: every,
        jitter_minutes: Number(form.schedule_jitter_minutes) || 0,
      };
    } else {
      schedule = { kind: 'manual' };
    }

    const surface =
      form.surface_kind === 'telegram'
        ? { kind: 'telegram' as const, chat_id: form.surface_chat_id.trim() }
        : { kind: 'web' as const };
    if (surface.kind === 'telegram' && !surface.chat_id) {
      toast.error('Telegram surface: chat_id required.');
      return;
    }

    // Quiet hours: both blank = no gate; otherwise the server validates HH:MM.
    const quietFrom = form.quiet_from.trim();
    const quietTo = form.quiet_to.trim();
    const quietHours =
      !quietFrom && !quietTo
        ? null
        : { from: quietFrom, to: quietTo, tz: form.quiet_tz.trim() || null };

    const nint = (s: string): number | null => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };

    const body: Record<string, unknown> = {
      slug: form.slug,
      name: form.name,
      description: form.description.trim() || null,
      agentSlug: form.agent_slug,
      skillSlug: form.skill_slug,
      schedule,
      surface,
      earliestAt: form.earliest_at ? new Date(form.earliest_at).toISOString() : null,
      maxFires: nint(form.max_fires),
      minIdleMinutes: nint(form.min_idle_minutes),
      quietHours,
      cooldownMinutes: nint(form.cooldown_minutes),
    };

    // state_text → state (object). Empty textarea = omit so create seeds from
    // the bound skill's defaultState and edit leaves existing state untouched.
    const rawState = form.state_text.trim();
    if (rawState.length > 0) {
      try {
        const parsed: unknown = JSON.parse(rawState);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          toast.error('State must be a JSON object (e.g. {"answered": []}).');
          return;
        }
        body.state = parsed;
      } catch (err) {
        toast.error(`State JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    try {
      if (editing?.mode === 'edit') {
        await apiSend(`/api/heartbeats/${editing.hb.id}`, 'PATCH', body);
      } else {
        await apiSend('/api/heartbeats', 'POST', body);
      }
      close();
      await queryClient.invalidateQueries({ queryKey: ['heartbeats'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = () => {
    const hb = deleteTarget;
    if (!hb) return;
    setDeleteTarget(null);
    if (editing?.mode === 'edit' && editing.hb.id === hb.id) close();
    startTransition(async () => {
      try {
        await apiSend(`/api/heartbeats/${hb.id}`, 'DELETE');
        await queryClient.invalidateQueries({ queryKey: ['heartbeats'] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const onToggle = (h: HeartbeatSummary) => {
    const desired = h.status === 'active' ? 'paused' : 'active';
    startTransition(async () => {
      try {
        await apiSend(`/api/heartbeats/${h.id}`, 'PATCH', { status: desired });
        await queryClient.invalidateQueries({ queryKey: ['heartbeats'] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const confirmFire = () => {
    const hb = fireTarget;
    if (!hb) return;
    setFireTarget(null);
    startTransition(async () => {
      try {
        await apiSend(`/api/heartbeats/${hb.id}/fire`, 'POST');
        await queryClient.invalidateQueries({ queryKey: ['heartbeats'] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (heartbeatsQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (heartbeatsQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {heartbeatsQuery.error instanceof Error
            ? heartbeatsQuery.error.message
            : 'Failed to load heartbeats.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => heartbeatsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: heartbeat list ─────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Heartbeats
          </h2>
          <Button onClick={openCreate} size="sm">
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {heartbeats.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No heartbeats yet. Click <strong>New</strong> to create one.
            </p>
          ) : (
            heartbeats.map((h) => {
              const selected = editing?.mode === 'edit' && editing.hb.id === h.id;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => openEdit(h)}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    selected && 'border-l-primary',
                    h.status !== 'active' && 'opacity-70',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{h.name}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                        statusBadgeClass(h.status),
                      )}
                    >
                      {h.status}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {h.agentSlug} · {h.skillSlug} · {h.scheduleKind} ·{' '}
                    {h.surface.kind === 'telegram' ? `tg:${h.surface.chat_id}` : 'web'} · fires=
                    {h.fireCount}
                  </div>
                  {h.nextFireAt && h.status === 'active' && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      next {formatDateTime(h.nextFireAt)}
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
                  {editing.mode === 'edit' ? editing.hb.name : 'New heartbeat'}
                </h2>
                {editing.mode === 'edit' && (
                  <p className="text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1.5 py-0.5">{editing.hb.slug}</code> ·{' '}
                    <Link href={`/heartbeats/${editing.hb.id}`} className="hover:underline">
                      fire history →
                    </Link>
                  </p>
                )}
              </div>
              {editing.mode === 'edit' && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setFireTarget(editing.hb)}
                    disabled={pending || editing.hb.status !== 'active'}
                  >
                    <Zap /> Fire
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onToggle(editing.hb)}
                    disabled={
                      pending ||
                      editing.hb.status === 'completed' ||
                      editing.hb.status === 'cancelled'
                    }
                  >
                    {editing.hb.status === 'active' ? (
                      <>
                        <Pause /> Pause
                      </>
                    ) : (
                      <>
                        <Play /> Resume
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(editing.hb)}
                    disabled={pending}
                  >
                    <Trash2 /> Delete
                  </Button>
                </div>
              )}
            </div>

            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input value={form.name} onChange={(e) => onName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Slug</Label>
                  <Input
                    value={form.slug}
                    disabled={editing.mode === 'edit'}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setForm((f) => ({ ...f, slug: slugify(e.target.value) }));
                    }}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label>Description (optional)</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Agent</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={form.agent_slug}
                    onChange={(e) => setForm((f) => ({ ...f, agent_slug: e.target.value }))}
                  >
                    <option value="">— choose —</option>
                    {agents.map((a) => (
                      <option key={a.slug} value={a.slug}>
                        {a.name} ({a.slug}, {a.role})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Skill</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={form.skill_slug}
                    onChange={(e) => {
                      const slug = e.target.value;
                      setForm((f) => {
                        // Pre-fill initial state from the picked skill's
                        // defaultState — but only when the operator
                        // hasn't manually edited the state textarea yet.
                        // Protects in-progress edits if they switch
                        // skills experimentally. Edit mode sets
                        // state_touched=true at fromHeartbeat time so
                        // existing heartbeats never get clobbered.
                        const next: FormState = { ...f, skill_slug: slug };
                        if (!f.state_touched && slug) {
                          const picked = skills.find((sk) => sk.slug === slug);
                          if (picked) {
                            next.state_text = JSON.stringify(picked.defaultState ?? {}, null, 2);
                          }
                        }
                        return next;
                      });
                    }}
                  >
                    <option value="">— choose —</option>
                    {skills.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name} ({s.slug})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="state_text">Initial state (JSON)</Label>
                <textarea
                  id="state_text"
                  value={form.state_text}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, state_text: e.target.value, state_touched: true }))
                  }
                  rows={6}
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                  placeholder={'{\n  "answered": [],\n  "expecting_reply": false\n}'}
                />
                <p className="text-xs text-muted-foreground">
                  Pre-fills from the chosen skill&apos;s default state on first pick. Edits here
                  only affect this heartbeat. See well-known keys in{' '}
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

              <fieldset className="space-y-3 rounded-md border p-4">
                <legend className="px-1 text-sm font-medium">Schedule</legend>
                {form.is_cron_locked && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
                    <strong>This heartbeat uses a cron schedule</strong>, which isn&apos;t supported
                    in v1 of the heartbeats form. Editing the schedule here would silently coerce to{' '}
                    <code>manual</code> and lose the cron expression — so it&apos;s locked.
                    <br />
                    To change this heartbeat&apos;s schedule, either edit the row directly via SQL,
                    or delete + recreate it with one of the v1-supported schedule kinds.
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  {(['interval', 'once', 'manual'] as const).map((k) => (
                    <label
                      key={k}
                      className={
                        'flex items-center gap-2 text-sm' +
                        (form.is_cron_locked ? ' opacity-50' : '')
                      }
                    >
                      <input
                        type="radio"
                        checked={form.schedule_kind === k}
                        disabled={form.is_cron_locked}
                        onChange={() => setForm((f) => ({ ...f, schedule_kind: k }))}
                      />
                      {k}
                    </label>
                  ))}
                </div>
                {form.schedule_kind === 'interval' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Every (minutes)</Label>
                      <Input
                        type="number"
                        min="1"
                        value={form.schedule_every_minutes}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, schedule_every_minutes: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Jitter ± (minutes)</Label>
                      <Input
                        type="number"
                        min="0"
                        value={form.schedule_jitter_minutes}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, schedule_jitter_minutes: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                )}
                {form.schedule_kind === 'once' && (
                  <div className="space-y-1">
                    <Label>Fire at</Label>
                    <DateTimePicker
                      value={form.schedule_at ? new Date(form.schedule_at) : null}
                      onChange={(d) =>
                        setForm((f) => ({
                          ...f,
                          schedule_at: d ? isoToLocalInput(d.toISOString()) : '',
                        }))
                      }
                      placeholder="Pick a date & time"
                    />
                  </div>
                )}
                {form.schedule_kind === 'manual' && (
                  <p className="text-xs text-muted-foreground">
                    Only fires via the &quot;Fire now&quot; button or the heartbeat_fire tool. No
                    auto-schedule.
                  </p>
                )}
              </fieldset>

              <fieldset className="space-y-3 rounded-md border p-4">
                <legend className="px-1 text-sm font-medium">Surface (where the reply goes)</legend>
                <div className="flex gap-4">
                  {(['telegram', 'web'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        checked={form.surface_kind === k}
                        onChange={() => setForm((f) => ({ ...f, surface_kind: k }))}
                      />
                      {k}
                    </label>
                  ))}
                </div>
                {form.surface_kind === 'telegram' && (
                  <div className="space-y-1">
                    <Label>Telegram chat_id</Label>
                    <Input
                      value={form.surface_chat_id}
                      onChange={(e) => setForm((f) => ({ ...f, surface_chat_id: e.target.value }))}
                      placeholder="e.g. 123456789"
                    />
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-3 rounded-md border p-4">
                <legend className="px-1 text-sm font-medium">
                  Gates — when is it appropriate to fire?
                </legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(['none', 'sensible', 'custom'] as const).map((p) => (
                    <label key={p} className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={form.gate_preset === p}
                        onChange={() => applyPreset(p)}
                      />
                      {p === 'sensible' ? 'sensible defaults' : p}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  No system-wide defaults. Blank fields mean &quot;no gate of this kind&quot;.
                  &quot;Sensible defaults&quot; fills in 15min idle, 22:00–07:00 quiet hours
                  (profile tz), 30min cooldown.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Min idle (minutes)</Label>
                    <Input
                      type="number"
                      min="0"
                      value={form.min_idle_minutes}
                      onChange={(e) => setForm((f) => ({ ...f, min_idle_minutes: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Cooldown (minutes)</Label>
                    <Input
                      type="number"
                      min="0"
                      value={form.cooldown_minutes}
                      onChange={(e) => setForm((f) => ({ ...f, cooldown_minutes: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Quiet from (HH:MM)</Label>
                    <Input
                      value={form.quiet_from}
                      placeholder="22:00"
                      onChange={(e) => setForm((f) => ({ ...f, quiet_from: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Quiet to (HH:MM)</Label>
                    <Input
                      value={form.quiet_to}
                      placeholder="07:00"
                      onChange={(e) => setForm((f) => ({ ...f, quiet_to: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label>Quiet tz (IANA, blank = profile tz)</Label>
                    <Input
                      value={form.quiet_tz}
                      placeholder="Africa/Johannesburg"
                      onChange={(e) => setForm((f) => ({ ...f, quiet_tz: e.target.value }))}
                    />
                  </div>
                </div>
              </fieldset>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Earliest at (optional)</Label>
                  <DateTimePicker
                    value={form.earliest_at ? new Date(form.earliest_at) : null}
                    onChange={(d) =>
                      setForm((f) => ({
                        ...f,
                        earliest_at: d ? isoToLocalInput(d.toISOString()) : '',
                      }))
                    }
                    placeholder="No earliest bound"
                    clearable
                  />
                </div>
                <div className="space-y-1">
                  <Label>Max fires (blank = unbounded)</Label>
                  <Input
                    type="number"
                    min="1"
                    value={form.max_fires}
                    onChange={(e) => setForm((f) => ({ ...f, max_fires: e.target.value }))}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={pending}>
                {editing.mode === 'edit' ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a heartbeat to edit, or create a new one.
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its fire history goes with it. This can’t be undone.
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

      <AlertDialog open={fireTarget !== null} onOpenChange={(o) => !o && setFireTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fire “{fireTarget?.name}” now?</AlertDialogTitle>
            <AlertDialogDescription>
              Gates (idle / quiet / cooldown) are bypassed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmFire}>Fire now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
