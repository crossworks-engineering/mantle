'use client';

/**
 * /settings/updates — current build, latest release, and the one-click
 * update flow against the updater sidecar.
 *
 * The interesting part is the progress loop: after requesting an update we
 * poll /api/updates/status. Mid-update the web container itself gets
 * recreated, so fetch failures are EXPECTED during the 'rolling' phase
 * (shown as "restarting"); when the endpoint answers again with a different
 * `version` than the one this bundle was built with, the new build is live
 * and we hard-reload onto it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import type { UpdateCheck, UpdaterStatus } from '@/lib/updates';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';

type Build = { version: string; sha: string; time: string };

type UpdatesData = {
  check: UpdateCheck;
  available: boolean;
  status: UpdaterStatus | null;
  build: Build;
};

/** Outer query-gate: loads the initial bundle so the page stays data-free, then
 *  renders the (unchanged, stateful + polling) view seeded from it. */
export function UpdatesClient() {
  const updatesQuery = useQuery({
    queryKey: ['updates'],
    queryFn: () => apiFetch<UpdatesData>('/api/updates'),
  });
  if (updatesQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (updatesQuery.isError && !updatesQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
        <p>Couldn&apos;t load update status.</p>
        <button type="button" onClick={() => updatesQuery.refetch()} className="underline">
          Retry
        </button>
      </div>
    );
  }
  const d = updatesQuery.data;
  return (
    <UpdatesView
      initialCheck={d.check}
      updaterAvailable={d.available}
      initialStatus={d.status}
      build={d.build}
    />
  );
}

const PHASE_LABEL: Record<string, string> = {
  requested: 'Waiting for the updater to pick up the request…',
  pulling: 'Pulling the new image…',
  rolling: 'Rolling the stack onto it…',
};

function UpdatesView({
  initialCheck,
  updaterAvailable,
  initialStatus,
  build,
}: {
  initialCheck: UpdateCheck;
  updaterAvailable: boolean;
  initialStatus: UpdaterStatus | null;
  build: Build;
}) {
  const toast = useToast();
  const [check, setCheck] = useState(initialCheck);
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState<UpdaterStatus | null>(initialStatus);
  const [log, setLog] = useState('');
  const [restarting, setRestarting] = useState(false);
  // Polling is active while an update runs (or one was just requested).
  const [updating, setUpdating] = useState(
    initialStatus?.phase === 'pulling' ||
      initialStatus?.phase === 'rolling' ||
      initialStatus?.phase === 'requested',
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => {
    if (!updating) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/updates/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          status: UpdaterStatus | null;
          log: string;
          version: string;
        };
        setRestarting(false);
        setStatus(data.status);
        setLog(data.log);
        // New build answering = the roll reached the web container. Reload
        // onto it (the running bundle is stale by definition now).
        if (data.version && data.version !== build.version) {
          stopPolling();
          window.location.reload();
          return;
        }
        if (data.status?.phase === 'done') {
          // Same version after 'done' — e.g. re-pulling an unchanged 'latest'.
          setUpdating(false);
          stopPolling();
          toast.success('Update finished.');
        } else if (data.status?.phase === 'error') {
          setUpdating(false);
          stopPolling();
          toast.error(data.status.error ?? 'Update failed — see the log.');
        }
      } catch {
        // Expected while the web container is being replaced.
        setRestarting(true);
      }
    }, 2000);
    return stopPolling;
  }, [updating, build.version, stopPolling, toast]);

  async function onCheckNow() {
    setChecking(true);
    try {
      setCheck(await apiSend<UpdateCheck>('/api/updates/check', 'POST'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update check failed');
    } finally {
      setChecking(false);
    }
  }

  async function onConfirmUpdate() {
    setConfirmOpen(false);
    const target = check.latest?.tag ?? 'latest';
    let res: { ok: true } | { ok: false; error: string };
    try {
      res = await apiSend<{ ok: true } | { ok: false; error: string }>(
        '/api/updates/request',
        'POST',
        { target },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update request failed');
      return;
    }
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setLog('');
    setStatus((s) => (s ? { ...s, phase: 'requested', target, error: null } : s));
    setUpdating(true);
  }

  const busy = updating || status?.phase === 'pulling' || status?.phase === 'rolling';
  const latest = check.latest;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      {/* ── Current build ── */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          This install
        </h2>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="text-2xl font-semibold">v{build.version}</span>
          <span className="text-xs text-muted-foreground">
            {[build.sha, build.time ? build.time.slice(0, 10) : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </section>

      {/* ── Latest release ── */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Latest release
          </h2>
          <Button variant="outline" size="sm" onClick={onCheckNow} disabled={checking || busy}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check now
          </Button>
        </div>

        {check.error ? (
          <p className="text-sm text-muted-foreground">{check.error}</p>
        ) : latest ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm">
                <span className="font-medium">{latest.tag}</span>
                {latest.publishedAt && (
                  <span className="text-muted-foreground">
                    {' '}
                    · published {latest.publishedAt.slice(0, 10)}
                  </span>
                )}
              </p>
              <a
                href={latest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
              >
                Release notes <ExternalLink className="size-3" />
              </a>
            </div>
            {check.updateAvailable ? (
              <Button onClick={() => setConfirmOpen(true)} disabled={!updaterAvailable || busy}>
                <ArrowUpCircle />
                Update to {latest.tag}
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" /> Up to date
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No release information yet.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Checked {check.checkedAt.slice(0, 16).replace('T', ' ')} UTC against the GitHub
          releases of <code>crossworks-engineering/mantle</code>.
        </p>
      </section>

      {/* ── Updater / progress ── */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Updater
        </h2>
        {!updaterAvailable ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              The updater sidecar isn&apos;t available on this deployment, so one-click
              updates are off. Update from the stack directory instead:
            </p>
            <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs">
              docker compose pull && docker compose up -d --wait
            </pre>
            <p>
              The sidecar ships with the compose stack — it needs{' '}
              <code>MANTLE_STACK_DIR</code> set in <code>.env</code> (see
              docs/self-hosting.md).
            </p>
          </div>
        ) : busy ? (
          <div className="space-y-3">
            <p className="inline-flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {restarting
                ? 'Services are restarting — this page will reload onto the new version…'
                : (PHASE_LABEL[status?.phase ?? ''] ?? 'Working…')}
              {status?.target && (
                <span className="text-muted-foreground">→ {status.target}</span>
              )}
            </p>
            {log && (
              <pre className="max-h-56 overflow-y-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed">
                {log}
              </pre>
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Ready. Updating pulls the new image and rolls every service; database
              migrations apply automatically before the app restarts. Expect about a
              minute of downtime.
            </p>
            {status?.phase === 'error' && status.error && (
              <p className="text-destructive">Last update failed: {status.error}</p>
            )}
            {status?.phase === 'done' && status.finishedAt && (
              <p>
                Last update: {status.target || 'latest'} ·{' '}
                {status.finishedAt.slice(0, 16).replace('T', ' ')} UTC
              </p>
            )}
            {log && (status?.phase === 'error' || status?.phase === 'done') && (
              <details>
                <summary className="cursor-pointer text-xs">Last update log</summary>
                <pre className="mt-2 max-h-56 overflow-y-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {log}
                </pre>
              </details>
            )}
          </div>
        )}
      </section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update to {latest?.tag}?</AlertDialogTitle>
            <AlertDialogDescription>
              Pulls the new image and restarts every service (about a minute of
              downtime). Migrations apply automatically. A recent backup
              (Settings → Backups) is cheap insurance first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmUpdate}>
              Update now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
