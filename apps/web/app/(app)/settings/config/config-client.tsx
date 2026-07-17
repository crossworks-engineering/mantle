'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { diffLines } from 'diff';
import { cn } from '@/lib/utils';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { AdoptKind } from '@/lib/system-manifest';
import type {
  ConfigDiffReport,
  EntityDiff,
  FieldDiff,
  DiffStatus,
} from '@/lib/system-manifest/config-diff';

// Status → text accent. Fills stay token-based (bg-muted); only the text/border
// carry the status colour, mirroring the sky hint precedent in tool-groups.
const STATUS_TEXT: Record<DiffStatus, string> = {
  ok: 'text-muted-foreground',
  modified: 'text-amber-600 dark:text-amber-400',
  missing: 'text-destructive',
  extra: 'text-sky-700 dark:text-sky-300',
};
const STATUS_BORDER: Record<DiffStatus, string> = {
  ok: 'border-l-border',
  modified: 'border-l-amber-500',
  missing: 'border-l-destructive',
  extra: 'border-l-sky-500',
};
const STATUS_LABEL: Record<DiffStatus, string> = {
  ok: 'OK',
  modified: 'Modified',
  missing: 'Missing',
  extra: 'Added',
};

type Section = { label: string; items: EntityDiff[] };

/** Group entities into the left-list sections (extras break out to the bottom). */
function sectionize(entities: EntityDiff[]): Section[] {
  const pick = (fn: (e: EntityDiff) => boolean) => entities.filter(fn);
  const notExtra = (k: EntityDiff['kind']) => (e: EntityDiff) =>
    e.kind === k && e.status !== 'extra';
  const sections: Section[] = [
    { label: 'Persona', items: pick((e) => e.kind === 'persona') },
    { label: 'Specialists', items: pick(notExtra('agent')) },
    { label: 'Skills', items: pick(notExtra('skill')) },
    { label: 'Tool groups', items: pick(notExtra('tool-group')) },
    { label: 'Workers', items: pick(notExtra('worker')) },
    { label: 'Operator-added', items: pick((e) => e.status === 'extra') },
  ];
  return sections.filter((s) => s.items.length > 0);
}

function StatusPill({ status }: { status: DiffStatus }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm bg-muted px-1 text-[10px] font-medium uppercase tracking-wider',
        STATUS_TEXT[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** A short value preview for the detail rows. */
function asText(v: string | string[] | null): string {
  if (v == null) return '—';
  return Array.isArray(v) ? (v.length ? v.join(', ') : '—') : v;
}

function isBody(field: string): boolean {
  return field === 'instructions' || field === 'systemPrompt';
}

/** Line-level diff (jsdiff) from the brain's current body → the template body, so
 *  `+` shows what adopting would add and `−` what it would drop. */
function DiffBody({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
      {parts.flatMap((p, i) =>
        p.value
          .replace(/\n$/, '')
          .split('\n')
          .map((ln, j) => (
            <div
              key={`${i}-${j}`}
              className={cn(
                'whitespace-pre-wrap',
                p.added && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                p.removed && 'bg-destructive/15 text-destructive',
                !p.added && !p.removed && 'text-muted-foreground',
              )}
            >
              <span className="select-none opacity-60">
                {p.added ? '+ ' : p.removed ? '− ' : '  '}
              </span>
              {ln || ' '}
            </div>
          )),
      )}
    </pre>
  );
}

function FieldRow({ field }: { field: FieldDiff }) {
  const isSet = field.added != null || field.removed != null;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium">{field.field}</span>
        {field.info && (
          <span className="rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            informational
          </span>
        )}
      </div>

      {isSet ? (
        <div className="mt-2 space-y-1.5">
          {field.removed && field.removed.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">In template, not in brain:</span>
              {field.removed.map((s) => (
                <span
                  key={s}
                  className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-destructive"
                >
                  − {s}
                </span>
              ))}
            </div>
          )}
          {field.added && field.added.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">In brain, not in template:</span>
              {field.added.map((s) => (
                <span
                  key={s}
                  className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-sky-700 dark:text-sky-300"
                >
                  + {s}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : isBody(field.field) ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {field.info ? 'Prompt differs from the template' : 'Body differs from the template'} —
            show diff
          </summary>
          <DiffBody
            before={asText(field.live) === '—' ? '' : asText(field.live)}
            after={asText(field.manifest) === '—' ? '' : asText(field.manifest)}
          />
        </details>
      ) : (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Template</p>
            <p className="font-mono text-xs">{asText(field.manifest)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">This brain</p>
            <p className="font-mono text-xs">{asText(field.live)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-kind one-liner shown in the adopt confirm dialog. */
function adoptDescription(e: EntityDiff): string {
  if (e.status === 'missing') return 'This will create it in your brain from the template.';
  switch (e.kind) {
    case 'persona':
      return 'Unions the template’s default tool groups, delegation, and skills onto your persona. Your persona’s prompt, model, and parameters are left untouched.';
    case 'agent':
      return 'Overwrites this specialist’s prompt, model, and parameters to the template, and adds any template tool groups/skills it’s missing. Groups/skills you added stay.';
    case 'skill':
      return 'Overwrites this skill’s instructions with the template version.';
    case 'tool-group':
      return 'Re-syncs this tool group’s membership to the template.';
    case 'worker':
      return 'Sets this worker’s model/provider to the template route — this can replace a model you tuned for cost.';
  }
}

/** Outer query-gate: fetches the diff report client-side so the page stays
 *  data-free, then renders the view (which seeds its selection from `report`). */
export function ConfigClient() {
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => apiFetch<{ report: ConfigDiffReport }>('/api/config').then((r) => r.report),
  });
  if (configQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (configQuery.isError && !configQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
        <p>Couldn&apos;t load the config report.</p>
        <Button variant="outline" size="sm" onClick={() => configQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <ConfigView report={configQuery.data} />;
}

function ConfigView({ report }: { report: ConfigDiffReport }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);

  const sections = useMemo(() => sectionize(report.entities), [report.entities]);
  // Auto-select the first entity that isn't OK, else the very first.
  const firstNonOk = report.entities.find((e) => e.status !== 'ok') ?? report.entities[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    firstNonOk ? `${firstNonOk.kind}:${firstNonOk.slug}` : null,
  );
  const selected = report.entities.find((e) => `${e.kind}:${e.slug}` === selectedKey) ?? firstNonOk;

  const { ok, modified, missing, extra } = report.counts;

  // Matches adoptAllAction's filter: adoptable minus modified workers (those need
  // a deliberate per-item click).
  const adoptAllCount = report.entities.filter(
    (e) => e.adoptable && !(e.kind === 'worker' && e.status === 'modified'),
  ).length;

  async function runAdopt(e: EntityDiff) {
    setSubmitting(true);
    try {
      await apiSend('/api/config/adopt', 'POST', { kind: e.kind as AdoptKind, slug: e.slug });
      toast.success(`Committed changes to ${e.name}`);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adopt failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function runAdoptAll() {
    setSubmitting(true);
    try {
      const res = await apiSend<{ ok: true; count: number }>('/api/config/adopt-all', 'POST');
      toast.success(`Committed ${res.count} change${res.count === 1 ? '' : 's'} from template`);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adopt-all failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: entity list ───────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Config vs template
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Template v{report.appVersion}
            {report.lastReconciledVersion
              ? ` · last synced v${report.lastReconciledVersion}`
              : ' · never auto-synced'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">{ok} OK</span>
            <span className={cn('rounded-sm bg-muted px-1.5 py-0.5', STATUS_TEXT.modified)}>
              {modified} modified
            </span>
            <span className={cn('rounded-sm bg-muted px-1.5 py-0.5', STATUS_TEXT.missing)}>
              {missing} missing
            </span>
            <span className={cn('rounded-sm bg-muted px-1.5 py-0.5', STATUS_TEXT.extra)}>
              {extra} added
            </span>
          </div>
          {adoptAllCount > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3 w-full"
                  disabled={submitting}
                >
                  Commit all ({adoptAllCount})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Commit {adoptAllCount} change{adoptAllCount === 1 ? '' : 's'} from the template?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Applies every committable item now (the same syncs the next version bump would
                    make). Worker model changes are excluded — commit those individually.
                    Operator-added items are never removed.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={runAdoptAll}>Commit all</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        <div className="space-y-3 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {sections.map((section) => (
            <div key={section.label} className="space-y-1.5">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
              {section.items.map((e) => {
                const key = `${e.kind}:${e.slug}`;
                const isSel = selected ? `${selected.kind}:${selected.slug}` === key : false;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className={cn(
                      'block w-full rounded-lg border border-l-[3px] border-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                      STATUS_BORDER[e.status],
                      isSel && 'bg-muted/50 ring-1 ring-ring',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{e.name}</span>
                      <StatusPill status={e.status} />
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {e.slug}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ── Right: entity detail ────────────────────────────────────── */}
      {/* `relative` keeps tall content out of <main>'s own scroll area. */}
      <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{selected.name}</h2>
                <p className="font-mono text-xs text-muted-foreground">
                  {selected.kind} · {selected.slug}
                </p>
              </div>
              <StatusPill status={selected.status} />
            </div>

            <p
              className={cn(
                'text-sm',
                selected.status === 'ok' ? 'text-muted-foreground' : STATUS_TEXT[selected.status],
              )}
            >
              {selected.summary}
            </p>

            {selected.kind === 'persona' && (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                The persona’s prompt, model, and parameters are operator-owned and are deliberately
                not compared — only its structure (tool groups, skills, delegation).
              </p>
            )}

            {selected.fields.length > 0 ? (
              <div className="space-y-2">
                {selected.fields.map((f) => (
                  <FieldRow key={f.field} field={f} />
                ))}
              </div>
            ) : selected.status === 'ok' ? (
              <p className="text-sm text-muted-foreground">
                Nothing to reconcile — this matches the template.
              </p>
            ) : null}

            <div className="border-t border-border pt-3">
              {selected.adoptable ? (
                <>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" size="sm" disabled={submitting}>
                        Commit changes
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Commit changes to “{selected.name}” from the template?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {adoptDescription(selected)}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => runAdopt(selected)}>
                          Commit
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Writes the manifest version to this brain now.
                  </p>
                </>
              ) : selected.status === 'extra' ? (
                <p className="text-xs text-muted-foreground">
                  Operator-added — not in the template. Committing never deletes it.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">In sync with the template.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <p className="text-sm text-muted-foreground">No config to compare.</p>
          </div>
        )}
      </div>
    </div>
  );
}
