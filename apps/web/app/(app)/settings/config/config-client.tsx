'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
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
  const notExtra = (k: EntityDiff['kind']) => (e: EntityDiff) => e.kind === k && e.status !== 'extra';
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

/** A short value preview for the detail header rows. */
function asText(v: string | string[] | null): string {
  if (v == null) return '—';
  return Array.isArray(v) ? (v.length ? v.join(', ') : '—') : v;
}

function isBody(field: string): boolean {
  return field === 'instructions' || field === 'systemPrompt';
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
            {field.info ? 'Prompt differs from the template' : 'Body differs from the template'} — show both
          </summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Template</p>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-[11px]">
                {asText(field.manifest)}
              </pre>
            </div>
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">This brain</p>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-[11px]">
                {asText(field.live)}
              </pre>
            </div>
          </div>
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

export function ConfigClient({ report }: { report: ConfigDiffReport }) {
  const sections = useMemo(() => sectionize(report.entities), [report.entities]);
  // Auto-select the first entity that isn't OK, else the very first.
  const firstNonOk = report.entities.find((e) => e.status !== 'ok') ?? report.entities[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    firstNonOk ? `${firstNonOk.kind}:${firstNonOk.slug}` : null,
  );
  const selected =
    report.entities.find((e) => `${e.kind}:${e.slug}` === selectedKey) ?? firstNonOk;

  const { ok, modified, missing, extra } = report.counts;

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
                    <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{e.slug}</div>
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

            <p className={cn('text-sm', selected.status === 'ok' ? 'text-muted-foreground' : STATUS_TEXT[selected.status])}>
              {selected.summary}
            </p>

            {selected.kind === 'persona' && (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                The persona’s prompt, model, and parameters are operator-owned and are
                deliberately not compared — only its structure (tool groups, skills,
                delegation).
              </p>
            )}

            {selected.fields.length > 0 ? (
              <div className="space-y-2">
                {selected.fields.map((f) => (
                  <FieldRow key={f.field} field={f} />
                ))}
              </div>
            ) : selected.status === 'ok' ? (
              <p className="text-sm text-muted-foreground">Nothing to reconcile — this matches the template.</p>
            ) : null}

            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              Adopting changes from the template lands in a later update. For now this is a
              read-only check.
            </p>
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
