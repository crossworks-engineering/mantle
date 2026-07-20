'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { localDay } from '@/lib/format-datetime';
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
import { useRealtime } from '@/components/realtime/use-realtime';
import { MaintenanceView } from './maintenance-tab';
import { ListPager } from '@/components/layout/list-pager';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import type {
  AuditCheck,
  AuditReport,
  AuditSeverity,
  Capabilities,
  CheckResult,
  LandedItem,
  LandedReport,
  LandedState,
  SystemCheck,
  SystemReport,
} from '@/lib/integrity/types';

/** The node types the live view tracks — mirrors `LANDED_TYPES` in landed.ts
 *  (kept as a literal here so the server module never enters the browser bundle). */
const LIVE_TYPES = ['note', 'page', 'task', 'event', 'contact', 'secret', 'file', 'email'];
const LIVE_PAGE_SIZE = 25;
const TYPE_LABELS: Record<string, string> = {
  note: 'Notes',
  page: 'Pages',
  task: 'Tasks',
  event: 'Events',
  contact: 'Contacts',
  secret: 'Secrets',
  file: 'Files',
  email: 'Email',
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
  const order: (keyof Capabilities)[] = [
    'extractor',
    'embedding',
    'tika',
    'vision',
    'summarizer',
    'reflector',
    'stt',
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Brain readiness
      </span>
      {order.map((k) => {
        const c = caps[k];
        const cls = c.available
          ? 'bg-primary/10 text-primary border-primary/30'
          : 'bg-muted text-muted-foreground border-border';
        return (
          <span
            key={k}
            title={c.detail}
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] ${cls}`}
          >
            <span className="font-mono">{c.available ? '✓' : '—'}</span>
            {CAP_LABELS[k]}
          </span>
        );
      })}
    </div>
  );
}

// ─── live view ──────────────────────────────────────────────────────────────

const LANDED_STATE_STYLE: Record<LandedState, { label: string; cls: string }> = {
  indexing: {
    label: 'INDEXING',
    cls: 'bg-muted text-muted-foreground border-border animate-pulse',
  },
  ok: { label: 'OK', cls: 'bg-primary/10 text-primary border-primary/30' },
  skipped: { label: 'SKIPPED', cls: 'bg-muted text-muted-foreground border-border' },
  fail: { label: 'FAIL', cls: 'bg-destructive/10 text-destructive border-destructive/30' },
  stalled: { label: 'STALLED', cls: 'bg-muted text-foreground border-border' },
};

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function LandedRow({
  item,
  onDelete,
  deleting,
}: {
  item: LandedItem;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const s = LANDED_STATE_STYLE[item.state];
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-left"
        >
          <span
            className={`inline-flex w-[5.25rem] shrink-0 justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider ${s.cls}`}
          >
            {s.label}
          </span>
          <span
            className="min-w-[8rem] max-w-[18rem] truncate text-sm font-medium text-foreground"
            title={item.title}
          >
            {item.title}
          </span>
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            {item.nodeType}
          </span>
          <span
            className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
            title={new Date(item.updatedAt).toLocaleString()}
          >
            {relTime(item.updatedAt)}
          </span>
          <span className="flex flex-wrap gap-1">
            {item.checks.map((c, i) => (
              <CheckPill key={i} check={c} />
            ))}
          </span>
        </button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={deleting}
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              {deleting ? '…' : '⌫'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{item.title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Permanently deletes this <code>{item.nodeType}</code> node and its entire brain
                footprint — summary, embedding, facts, and graph edges — via the real cascade +
                reaper path. This is your actual data and cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete(item.nodeId)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {open && (
        <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          {item.checks.map((c, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">{c.label}</span>
              <span className="font-mono">{c.status}</span>
              {c.detail && <span className="text-muted-foreground">— {c.detail}</span>}
            </div>
          ))}
          {item.footprint.run && (
            <div className="flex gap-2 pt-1 text-muted-foreground">
              <span className="w-24 shrink-0">steps</span>
              <span className="font-mono">{item.footprint.run.stepNames.join(' → ') || '—'}</span>
            </div>
          )}
          <div className="flex gap-2 pt-1 text-muted-foreground">
            <span className="w-24 shrink-0">added</span>
            <span className="tabular-nums text-foreground">
              {new Date(item.createdAt).toLocaleString()}
            </span>
          </div>
          <a href={`/nodes/${item.nodeId}/history`} className="inline-block pt-1 underline">
            node biography →
          </a>
        </div>
      )}
    </li>
  );
}

function LiveView() {
  const toast = useToast();
  const [report, setReport] = useState<LandedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(LIVE_PAGE_SIZE),
          offset: String((page - 1) * LIVE_PAGE_SIZE),
          order,
        });
        if (typeFilter !== 'all') params.set('types', typeFilter);
        const data = await apiFetch<LandedReport>(
          `/api/debug/integrity/landed?${params.toString()}`,
        );
        setReport(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
        if (!quiet) toast.error(err instanceof Error ? err.message : 'Load failed');
      } finally {
        setLoading(false);
      }
    },
    [toast, page, order, typeFilter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // If deletions/filtering shrink the set below the current page, step back so
  // we never sit on an empty page past the end.
  useEffect(() => {
    if (!report) return;
    const totalPages = Math.max(1, Math.ceil(report.total / LIVE_PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [report, page]);

  // Live updates: any insert (node_ingested) or re-index (node_indexed) of a
  // tracked type schedules a quiet refetch — debounced so a burst coalesces.
  const scheduleRefetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(true), 500);
  }, [load]);
  useRealtime(LIVE_TYPES, scheduleRefetch);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function remove(nodeId: string) {
    setDeleting(nodeId);
    try {
      await apiSend('/api/debug/integrity/landed/delete', 'POST', { nodeId });
      setReport((r) =>
        r
          ? {
              ...r,
              items: r.items.filter((i) => i.nodeId !== nodeId),
              total: Math.max(0, r.total - 1),
            }
          : r,
      );
      toast.success('Deleted node + footprint');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  }

  const filtered = typeFilter !== 'all';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Live brain activity
        </h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          The real content you add — notes, pages, tasks, events, contacts, secrets, files, email —
          as it lands in the brain. Each row shows whether the extractor indexed it (L5 summary ·
          768-dim embedding · tsv · L4 facts · graph). <strong>Green</strong> = fully indexed;{' '}
          <strong>skipped</strong> shows a correct non-index with its reason; <strong>fail</strong>{' '}
          flags a real gap (success but no summary, dimension drift, duplicate edges). Filter by
          type and page through the whole corpus; new content still appears automatically.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={typeFilter}
          onValueChange={(v) => {
            setTypeFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {LIVE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={order}
          onValueChange={(v) => {
            setOrder(v as 'newest' | 'oldest');
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[160px]" aria-label="Sort order">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {report && <CapabilitiesPanel caps={report.capabilities} />}

      {report && report.items.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <ul className="divide-y divide-border">
            {report.items.map((item) => (
              <LandedRow
                key={item.nodeId}
                item={item}
                onDelete={remove}
                deleting={deleting === item.nodeId}
              />
            ))}
          </ul>
          <ListPager
            page={page}
            total={report.total}
            pageSize={LIVE_PAGE_SIZE}
            pending={loading}
            onGo={(p) => setPage(p)}
          />
        </div>
      )}

      {report && report.items.length === 0 && (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          {filtered
            ? `No ${TYPE_LABELS[typeFilter] ?? typeFilter} yet.`
            : 'No content yet. Add a note, upload a file, or create an event and watch it land in the brain here.'}
        </p>
      )}

      {!report && loading && (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          Loading recent activity…
        </p>
      )}
    </div>
  );
}

// ─── corpus audit (unchanged) ───────────────────────────────────────────────

const SEVERITY_STYLE: Record<AuditSeverity, string> = {
  high: 'bg-destructive/10 text-destructive border-destructive/30',
  medium: 'bg-muted text-foreground border-border',
  low: 'bg-muted text-muted-foreground border-border',
};

/** Format an audit check's age span + decide whether it reads as "recent"
 *  (the live pipeline may still be producing these) vs inert pre-fix sediment. */
function spanMeta(check: AuditCheck): { text: string; recent: boolean } | null {
  if (check.ok || !check.oldestAt || !check.newestAt) return null;
  const text =
    check.oldestAt === check.newestAt ? check.oldestAt : `${check.oldestAt} → ${check.newestAt}`;
  const cutoff = localDay(new Date(Date.now() - 2 * 86_400_000)); // local date, not UTC
  return { text, recent: check.newestAt >= cutoff };
}

function AuditRow({ check }: { check: AuditCheck }) {
  const [open, setOpen] = useState(false);
  const span = spanMeta(check);
  const countCls = check.ok
    ? 'bg-primary/10 text-primary border-primary/30'
    : check.severity === 'high'
      ? 'bg-destructive/10 text-destructive border-destructive/30'
      : 'bg-muted text-foreground border-border';
  return (
    <li className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-left"
      >
        <span
          className={`inline-flex w-[64px] shrink-0 justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider ${countCls}`}
        >
          {check.ok ? 'OK' : `${check.count}${check.capped ? '+' : ''}`}
        </span>
        <span className="min-w-[200px] text-sm font-medium text-foreground">{check.label}</span>
        <span
          className={`rounded-sm border px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${SEVERITY_STYLE[check.severity]}`}
        >
          {check.severity}
        </span>
        {span && (
          <span
            className={`rounded-sm border px-1.5 py-0.5 text-[11px] tabular-nums ${span.recent ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted text-muted-foreground'}`}
            title={
              span.recent
                ? 'Newest violation is recent — the live pipeline may still be producing these'
                : 'All violations are older — likely pre-fix sediment, safe to backfill/clean'
            }
          >
            {span.recent ? '⚠ ' : ''}
            {span.text}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <p className="text-muted-foreground">{check.note}</p>
          {span && (
            <p className="text-[11px] text-muted-foreground">
              Age span: <span className="tabular-nums text-foreground">{span.text}</span>
              {span.recent
                ? ' · newest is recent — may be a live regression'
                : ' · all older — likely pre-fix sediment'}
            </p>
          )}
          {check.samples.length > 0 && (
            <div className="space-y-1 border-t border-border pt-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Samples
              </div>
              {check.samples.map((sm) => (
                <div key={sm.id} className="flex gap-2">
                  <span className="rounded-sm bg-muted px-1 font-mono text-[11px] text-muted-foreground">
                    {sm.kind}
                  </span>
                  <span className="text-muted-foreground">{sm.detail}</span>
                  <a href={`/nodes/${sm.id}/history`} className="font-mono text-[11px] underline">
                    {sm.id.slice(0, 8)}
                  </a>
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
      const data = await apiFetch<AuditReport>('/api/debug/integrity/audit');
      setReport(data);
      toast.success(
        data.totalViolations === 0
          ? 'Corpus clean — no violations'
          : `${data.totalViolations} violations across ${data.checks.filter((c) => !c.ok).length} checks`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      toast.error(err instanceof Error ? err.message : 'Audit failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Corpus audit
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Read-only scan of your <strong>existing</strong> brain for invariant violations —
            silent-miss nodes, embedding-dimension drift, unembedded or reaper-missed facts,
            duplicate edges, orphan/over-merged entities. No writes, no cost. Complements the live
            view: the live view shows new content indexing correctly; this proves the data already
            stored is consistent.
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
            <span className="text-muted-foreground">
              {report.checks.filter((c) => c.ok).length}/{report.checks.length} checks passed
            </span>
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

// ─── system config integrity ────────────────────────────────────────────────

function SystemRow({ check }: { check: SystemCheck }) {
  const [open, setOpen] = useState(false);
  const badgeCls = check.ok
    ? 'bg-primary/10 text-primary border-primary/30'
    : check.severity === 'high'
      ? 'bg-destructive/10 text-destructive border-destructive/30'
      : 'bg-muted text-foreground border-border';
  const hasDetail = Boolean(check.detail) || (check.samples?.length ?? 0) > 0;
  return (
    <li className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-left"
        disabled={!hasDetail}
      >
        <span
          className={`inline-flex w-[64px] shrink-0 justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider ${badgeCls}`}
        >
          {check.ok ? 'OK' : `${check.samples?.length ?? '!'}`}
        </span>
        <span className="min-w-[200px] text-sm font-medium text-foreground">{check.label}</span>
        <span
          className={`rounded-sm border px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${SEVERITY_STYLE[check.severity]}`}
        >
          {check.severity}
        </span>
        <span className="text-xs text-muted-foreground">— {check.detail}</span>
      </button>
      {open && (check.samples?.length ?? 0) > 0 && (
        <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          {check.samples!.map((sm) => (
            <div key={sm.id} className="flex gap-2">
              <span className="rounded-sm bg-muted px-1 font-mono text-[11px] text-muted-foreground">
                {sm.id}
              </span>
              <span className="text-muted-foreground">{sm.detail}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function SystemView() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SystemReport | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const data = await apiFetch<SystemReport>('/api/debug/integrity/system');
      setReport(data);
      toast.success(
        data.problems === 0
          ? 'Config clean — every vital link resolves'
          : `${data.problems} config check(s) failing`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      toast.error(err instanceof Error ? err.message : 'Check failed');
    } finally {
      setRunning(false);
    }
  }, [toast]);

  // Auto-run once on first open. Deliberately NOT keyed on `run`: the toast
  // provider's api object isn't memoized, so `run` re-identifies every time a
  // toast is pushed — keying the effect on it would re-fetch on each success
  // toast, an infinite loop. Mount-once is the right shape for a one-shot check.

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once; `run` re-identifies every render (toast api unmemoized), so keying on it would infinite-loop
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            System config
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Read-only check of the <strong>agent / skill / tool / worker link graph</strong> against
            the system manifest. Catches what the runtime hides: an agent referencing a skill or
            tool with no row (it silently drops), a specialist not wired into the persona&apos;s{' '}
            <code>delegate_to</code>, a missing default worker.
            <strong> Green</strong> = every vital link resolves.
          </p>
        </div>
        <Button onClick={run} disabled={running}>
          {running ? 'Checking…' : 'Re-check'}
        </Button>
      </div>

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm">
            <span className="font-semibold">
              {report.problems === 0
                ? 'Healthy'
                : `${report.problems} problem${report.problems === 1 ? '' : 's'}`}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {report.checks.filter((c) => c.ok).length}/{report.checks.length} checks passed
            </span>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {report.checks.map((c) => (
              <SystemRow key={c.key} check={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function IntegrityClient() {
  const [mode, setMode] = useState<'live' | 'audit' | 'system' | 'maintenance'>('live');
  const LABELS = {
    live: 'Live',
    audit: 'Corpus audit',
    system: 'System config',
    maintenance: 'Maintenance',
  } as const;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {(['live', 'audit', 'system', 'maintenance'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={
              'rounded-t-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (mode === m
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {LABELS[m]}
          </button>
        ))}
      </div>

      {mode === 'live' ? (
        <LiveView />
      ) : mode === 'audit' ? (
        <AuditView />
      ) : mode === 'system' ? (
        <SystemView />
      ) : (
        <MaintenanceView />
      )}
    </div>
  );
}
