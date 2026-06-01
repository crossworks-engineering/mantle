'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
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
import type { CheckResult, FixtureResult, FixtureState, SuiteReport } from '@/lib/integrity/types';

type SpecMeta = { key: string; label: string; nodeType: string; pipeline: 'content' | 'file' };

const STATE_STYLE: Record<FixtureState, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-primary/10 text-primary border-primary/30' },
  fail: { label: 'FAIL', cls: 'bg-destructive/10 text-destructive border-destructive/30' },
  stalled: { label: 'STALLED', cls: 'bg-muted text-foreground border-border' },
  missing: { label: 'MISSING', cls: 'bg-muted text-muted-foreground border-border' },
  error: { label: 'ERROR', cls: 'bg-destructive/10 text-destructive border-destructive/30' },
};

function CheckPill({ check }: { check: CheckResult }) {
  const cls =
    check.status === 'pass'
      ? 'bg-primary/10 text-primary border-primary/30'
      : check.status === 'fail'
        ? 'bg-destructive/10 text-destructive border-destructive/30'
        : 'bg-muted text-muted-foreground border-border';
  const glyph = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : 'i';
  return (
    <span
      title={check.detail}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] ${cls}`}
    >
      <span className="font-mono">{glyph}</span>
      {check.label}
    </span>
  );
}

function ResultRow({ result }: { result: FixtureResult }) {
  const [open, setOpen] = useState(false);
  const s = STATE_STYLE[result.state];
  return (
    <li className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-left"
      >
        <span
          className={`inline-flex w-[68px] shrink-0 justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider ${s.cls}`}
        >
          {s.label}
        </span>
        <span className="min-w-[150px] text-sm font-medium text-foreground">{result.label}</span>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {result.nodeType}
        </span>
        <span className="flex flex-wrap gap-1">
          {result.checks.map((c, i) => (
            <CheckPill key={i} check={c} />
          ))}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          {result.checks.map((c, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">{c.label}</span>
              <span className="font-mono">{c.status}</span>
              {c.detail && <span className="text-muted-foreground">— {c.detail}</span>}
            </div>
          ))}
          {result.footprint?.run && (
            <div className="flex gap-2 pt-1 text-muted-foreground">
              <span className="w-24 shrink-0">steps</span>
              <span className="font-mono">{result.footprint.run.stepNames.join(' → ') || '—'}</span>
            </div>
          )}
          {result.nodeId && (
            <a href={`/nodes/${result.nodeId}/history`} className="inline-block pt-1 underline">
              node biography →
            </a>
          )}
        </div>
      )}
    </li>
  );
}

export function IntegrityClient({ specs }: { specs: SpecMeta[] }) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [report, setReport] = useState<SuiteReport | null>(null);

  async function runSuite() {
    setRunning(true);
    try {
      const res = await fetch('/api/debug/integrity/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data = (await res.json()) as SuiteReport;
      setReport(data);
      toast.success(`Integrity run complete — ${data.passed}/${data.total} passed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  async function cleanup(tag?: string) {
    setCleaning(true);
    try {
      const res = await fetch('/api/debug/integrity/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tag ? { tag } : {}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const r = (await res.json()) as { nodesDeleted: number; tracesDeleted: number; entitiesDeleted: number };
      toast.success(`Cleaned ${r.nodesDeleted} nodes · ${r.tracesDeleted} traces · ${r.entitiesDeleted} entities`);
      if (tag && report?.runTag === tag) setReport(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  }

  const allStalled = report && report.results.length > 0 && report.results.every((r) => r.state === 'stalled');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Active integrity probe
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Inserts one synthetic fixture per content type, waits for the extractor, and
            asserts the expected footprint landed (L5 summary · 768-dim embedding · L4 facts ·
            graph). Green = matched the expectation for that type (including correct skips).
            Clean up the run afterward to remove fixtures + their traces.
          </p>
        </div>
        <Button onClick={runSuite} disabled={running || cleaning}>
          {running ? 'Running…' : 'Run integrity suite'}
        </Button>
      </div>

      {!report && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {specs.map((s) => (
            <li key={s.key} className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground">
              <span className="min-w-[150px] text-foreground">{s.label}</span>
              <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider">
                {s.nodeType}
              </span>
              <span className="text-xs">{s.pipeline}</span>
            </li>
          ))}
        </ul>
      )}

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm">
            <span className="font-semibold">
              {report.passed}/{report.total} passed
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              cost ${(report.totalCostMicroUsd / 1_000_000).toFixed(4)}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{(report.durationMs / 1000).toFixed(1)}s</span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-xs text-muted-foreground">{report.runTag}</span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReport(null)} disabled={cleaning}>
                Dismiss
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={cleaning}>
                    {cleaning ? 'Cleaning…' : 'Clean up this run'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clean up this run?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Deletes the {report.total} probe fixtures tagged{' '}
                      <code>{report.runTag}</code> (via the real delete path — exercising the
                      cascade + reaper triggers) and the traces they produced. Synthetic
                      entities orphaned by the delete are swept too.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => cleanup(report.runTag)}>
                      Clean up
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          {allStalled && (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              Every fixture stalled — no extractor_run terminated. Check that{' '}
              <code>apps/agent</code> is running and an <code>extractor</code> worker is
              configured at <a href="/settings/ai-workers" className="underline">/settings/ai-workers</a>.
            </p>
          )}

          <ul className="divide-y divide-border rounded-md border border-border">
            {report.results.map((r) => (
              <ResultRow key={r.key} result={r} />
            ))}
          </ul>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => cleanup()} disabled={cleaning}>
              Clean ALL probe data
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
