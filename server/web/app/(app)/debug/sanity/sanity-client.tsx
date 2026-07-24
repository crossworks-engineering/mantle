'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiFetch, ApiError } from '@mantle/web-ui/api-fetch';
import type { SanityCheck, SanityReport, SanityStatus } from '@/lib/sanity/types';
import { copyText } from '@mantle/web-ui/lib/secure-context-fallbacks';

const STATUS_STYLE: Record<SanityStatus, { badge: string; glyph: string; label: string }> = {
  pass: { badge: 'bg-primary/10 text-primary border-primary/30', glyph: '✓', label: 'PASS' },
  warn: { badge: 'bg-muted text-foreground border-border', glyph: '!', label: 'WARN' },
  fail: {
    badge: 'bg-destructive/10 text-destructive border-destructive/30',
    glyph: '✗',
    label: 'FAIL',
  },
  na: { badge: 'bg-muted text-muted-foreground border-border', glyph: '—', label: 'N/A' },
};

// Severity order: surface the breaks first, the noise (na/pass) last.
const ORDER: Record<SanityStatus, number> = { fail: 0, warn: 1, pass: 2, na: 3 };

function CopyButton({ text }: { text: string }) {
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void copyText(text).then(
          () => toast.success('Copied'),
          () => toast.error('Copy failed'),
        );
      }}
    >
      Copy
    </Button>
  );
}

function CheckRow({ check }: { check: SanityCheck }) {
  const [open, setOpen] = useState(false);
  const s = STATUS_STYLE[check.status];
  const expandable = Boolean(check.fix);
  return (
    <li className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!expandable}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-left disabled:cursor-default"
      >
        <span
          className={`inline-flex w-[56px] shrink-0 items-center justify-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider ${s.badge}`}
        >
          <span className="font-mono">{s.glyph}</span>
          {s.label}
        </span>
        <span className="min-w-[160px] text-sm font-medium text-foreground">{check.label}</span>
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {check.category}
        </span>
        <span className="flex-1 text-xs text-muted-foreground">{check.detail}</span>
        {expandable && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {open ? 'Hide fix' : 'Show fix'}
          </span>
        )}
      </button>

      {open && check.fix && (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs">
          <p className="text-foreground">{check.fix.summary}</p>
          {check.fix.command && (
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
                {check.fix.command}
              </pre>
              <CopyButton text={check.fix.command} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function SanityClient() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SanityReport | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const data = await apiFetch<SanityReport>('/api/debug/sanity');
      setReport(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      toast.error(err instanceof Error ? err.message : 'Check failed');
    } finally {
      setRunning(false);
    }
  }, [toast]);

  // Auto-run once on open. Not keyed on `run` — the toast api object isn't
  // memoized, so keying would re-fetch on every toast (see integrity-client).

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once; `run` re-identifies every render (toast api unmemoized), so keying on it would infinite-loop
  }, []);

  const sorted = report ? [...report.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]) : [];
  const headline = report
    ? report.fails > 0
      ? `${report.fails} check${report.fails === 1 ? '' : 's'} failing`
      : report.warns > 0
        ? `${report.warns} warning${report.warns === 1 ? '' : 's'}`
        : 'All clear'
    : '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            System sanity
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Read-only checks for features that break <strong>silently</strong> — a setting hidden in
            env, or a provisioning step only <code>scripts/up.sh</code> runs (so a registry-pull box
            that never ran it looks healthy yet a feature is dead). Catches the missing MinIO bucket
            that fails every app build, an unconfigured updater (<code>MANTLE_STACK_DIR</code>) that
            hangs updates, missing secrets, a stray files root, a localhost public URL, an unloaded
            embedder model. Each failure shows the fix — nothing is changed from here.
          </p>
        </div>
        <Button onClick={run} disabled={running}>
          {running ? 'Checking…' : 'Re-check'}
        </Button>
      </div>

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm">
            <span className="font-semibold">{headline}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {report.checks.filter((c) => c.status === 'pass').length}/{report.checks.length}{' '}
              passing
            </span>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {sorted.map((c) => (
              <CheckRow key={c.key} check={c} />
            ))}
          </ul>
        </div>
      )}

      {!report && running && (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          Running checks…
        </p>
      )}
    </div>
  );
}
