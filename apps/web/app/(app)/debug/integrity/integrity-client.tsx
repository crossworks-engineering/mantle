'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import type {
  AuditCheck,
  AuditReport,
  AuditSeverity,
  Capabilities,
  CheckResult,
  FixtureResult,
  FixtureState,
  SuiteReport,
} from '@/lib/integrity/types';

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

function groupPillStyle(checks: CheckResult[]): string {
  if (checks.some((c) => c.status === 'fail'))
    return 'bg-destructive/10 text-destructive border-destructive/30';
  if (checks.some((c) => c.status === 'pass'))
    return 'bg-primary/10 text-primary border-primary/30';
  return 'bg-muted text-muted-foreground border-border';
}

function CheckGroup({ title, checks }: { title: string; checks: CheckResult[] }) {
  return (
    <div className="space-y-1 border-t border-border pt-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {checks.map((c, i) => (
        <div key={i} className="flex gap-2">
          <span className="w-24 shrink-0 text-muted-foreground">{c.label}</span>
          <span className="font-mono">{c.status}</span>
          {c.detail && <span className="text-muted-foreground">— {c.detail}</span>}
        </div>
      ))}
    </div>
  );
}

const CAP_LABELS: Record<keyof Capabilities, string> = {
  tika: 'Tika',
  vision: 'Vision',
  extractor: 'Extractor',
  embedding: 'Embedder',
  summarizer: 'Summarizer',
  reflector: 'Reflector',
  stt: 'STT (voice)',
};

function CapabilitiesPanel({ caps }: { caps: Capabilities }) {
  const order: (keyof Capabilities)[] = ['extractor', 'embedding', 'tika', 'vision', 'summarizer', 'reflector', 'stt'];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Brain readiness</span>
      {order.map((k) => {
        const c = caps[k];
        const cls = c.available
          ? 'bg-primary/10 text-primary border-primary/30'
          : 'bg-muted text-muted-foreground border-border';
        return (
          <span key={k} title={c.detail} className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] ${cls}`}>
            <span className="font-mono">{c.available ? '✓' : '—'}</span>
            {CAP_LABELS[k]}
          </span>
        );
      })}
    </div>
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
          {result.updateChecks && (
            <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] ${groupPillStyle(result.updateChecks)}`}>
              ↻ update
            </span>
          )}
          {result.deleteChecks && (
            <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] ${groupPillStyle(result.deleteChecks)}`}>
              ⌫ delete
            </span>
          )}
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
          {result.updateChecks && <CheckGroup title="Update (re-extraction)" checks={result.updateChecks} />}
          {result.deleteChecks && <CheckGroup title="Delete (kind-aware reapers)" checks={result.deleteChecks} />}
          {result.nodeId && !result.deleted && (
            <a href={`/nodes/${result.nodeId}/history`} className="inline-block pt-1 underline">
              node biography →
            </a>
          )}
          {result.deleted && <div className="pt-1 text-muted-foreground">node deleted by the delete sub-test</div>}
        </div>
      )}
    </li>
  );
}

const SEVERITY_STYLE: Record<AuditSeverity, string> = {
  high: 'bg-destructive/10 text-destructive border-destructive/30',
  medium: 'bg-muted text-foreground border-border',
  low: 'bg-muted text-muted-foreground border-border',
};

function AuditRow({ check }: { check: AuditCheck }) {
  const [open, setOpen] = useState(false);
  const countCls = check.ok
    ? 'bg-primary/10 text-primary border-primary/30'
    : check.severity === 'high'
      ? 'bg-destructive/10 text-destructive border-destructive/30'
      : 'bg-muted text-foreground border-border';
  return (
    <li className="px-3 py-2.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-left">
        <span className={`inline-flex w-[64px] shrink-0 justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider ${countCls}`}>
          {check.ok ? 'OK' : `${check.count}${check.capped ? '+' : ''}`}
        </span>
        <span className="min-w-[200px] text-sm font-medium text-foreground">{check.label}</span>
        <span className={`rounded-sm border px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${SEVERITY_STYLE[check.severity]}`}>
          {check.severity}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <p className="text-muted-foreground">{check.note}</p>
          {check.samples.length > 0 && (
            <div className="space-y-1 border-t border-border pt-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Samples</div>
              {check.samples.map((s) => (
                <div key={s.id} className="flex gap-2">
                  <span className="rounded-sm bg-muted px-1 font-mono text-[11px] text-muted-foreground">{s.kind}</span>
                  <span className="text-muted-foreground">{s.detail}</span>
                  <a href={`/nodes/${s.id}/history`} className="font-mono text-[11px] underline">{s.id.slice(0, 8)}</a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function AuditView() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<AuditReport | null>(null);

  async function runAudit() {
    setRunning(true);
    try {
      const res = await fetch('/api/debug/integrity/audit');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data = (await res.json()) as AuditReport;
      setReport(data);
      toast.success(data.totalViolations === 0 ? 'Corpus clean — no violations' : `${data.totalViolations} violations across ${data.checks.filter((c) => !c.ok).length} checks`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Audit failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Corpus audit</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Read-only scan of your <strong>existing</strong> brain for invariant violations — silent-miss nodes,
            embedding-dimension drift, unembedded or reaper-missed facts, duplicate edges, orphan/over-merged
            entities. No writes, no cost. Complements the probe: the probe proves the pipeline works on synthetic
            inputs; this proves your real data is consistent.
          </p>
        </div>
        <Button onClick={runAudit} disabled={running}>
          {running ? 'Scanning…' : 'Run corpus audit'}
        </Button>
      </div>

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm">
            <span className="font-semibold">
              {report.totalViolations === 0 ? 'Clean' : `${report.totalViolations} violations`}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{report.checks.filter((c) => c.ok).length}/{report.checks.length} checks passed</span>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {report.checks.map((c) => (
              <AuditRow key={c.key} check={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function IntegrityClient({ specs }: { specs: SpecMeta[] }) {
  const [mode, setMode] = useState<'probe' | 'audit'>('probe');
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [includeUpdate, setIncludeUpdate] = useState(false);
  const [includeDelete, setIncludeDelete] = useState(false);
  const [report, setReport] = useState<SuiteReport | null>(null);

  async function runSuite() {
    setRunning(true);
    try {
      const res = await fetch('/api/debug/integrity/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeUpdate, includeDelete }),
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
      <div className="flex gap-1 border-b border-border">
        {(['probe', 'audit'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={
              'rounded-t-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (mode === m ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground')
            }
          >
            {m === 'probe' ? 'Active probe' : 'Corpus audit'}
          </button>
        ))}
      </div>

      {mode === 'audit' && <AuditView />}

      {mode === 'probe' && (
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
            Optional <strong>update</strong> tests assert an edit re-extracts (no duplicate
            edges); <strong>delete</strong> tests assert the kind-aware reapers fire (and
            self-remove the fixture). Clean up the run afterward to remove fixtures + traces.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Button onClick={runSuite} disabled={running || cleaning}>
            {running ? 'Running…' : 'Run integrity suite'}
          </Button>
          <div className="flex gap-4">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={includeUpdate}
                onCheckedChange={(v) => setIncludeUpdate(v === true)}
                disabled={running}
              />
              Update tests
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={includeDelete}
                onCheckedChange={(v) => setIncludeDelete(v === true)}
                disabled={running}
              />
              Delete tests
            </label>
          </div>
        </div>
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
          <CapabilitiesPanel caps={report.capabilities} />
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
                    <AlertDialogAction
                      onClick={() => cleanup(report.runTag)}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
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
      )}
    </div>
  );
}
