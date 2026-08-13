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
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import { useToast } from '@mantle/web-ui/ui/toast';
import type { ComposeStatus, UpdateCheck, UpdaterStatus } from '@mantle/client-types';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';

type Build = { version: string; sha: string; time: string };

type UpdatesData = {
  check: UpdateCheck;
  available: boolean;
  status: UpdaterStatus | null;
  compose: ComposeStatus | null;
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
      compose={d.compose}
      build={d.build}
    />
  );
}

/** One line under the build identity: whether the box's docker-compose.yml
 *  matches the canonical this release ships (the release-owned compose
 *  contract — see docs/deploy.md). 'unknown' (dev, old sidecar) renders
 *  nothing rather than a false alarm. */
function ComposeLine({ compose }: { compose: ComposeStatus | null }) {
  if (!compose || compose.state === 'unknown') return null;
  if (compose.state === 'in-sync') {
    return (
      <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-500" />
        Stack compose is in sync with this release.
      </p>
    );
  }
  const detail =
    compose.state === 'modified'
      ? 'docker-compose.yml has local edits, so release compose changes (services, healthchecks, mounts) are NOT applied on update. Move customization to docker-compose.override.yml + .env, then run scripts/compose-adopt.sh from the stack dir.'
      : compose.state === 'no-baseline'
        ? 'Compose auto-refresh is not adopted on this box yet. Run scripts/compose-adopt.sh once from the stack dir; updates refresh it automatically after that.'
        : 'docker-compose.yml is from an older release (pristine, but the refresh has not run). Update via the updater to refresh it, or re-run scripts/compose-adopt.sh.';
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive-ink">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium">
          {compose.state === 'stale' ? 'Stack compose is stale. ' : 'Stack compose has drifted. '}
        </span>
        {detail}
      </span>
    </p>
  );
}

/** The updater sidecar's own script. Silent when in-sync or unknown — the
 *  point is only to make the two states that COST something visible.
 *
 *  'stale' is not an alarm: the script self-refreshes at the end of the next
 *  successful update (v0.206+). It is shown because a stale script is exactly
 *  what made the 2026-07-26 fleet failure invisible — every box rolled the
 *  server stack, reported ok, and skipped the client stack — so "the update
 *  succeeded" is not, on its own, evidence that it did everything. */
function UpdaterScriptLine({ compose }: { compose: ComposeStatus | null }) {
  const state = compose?.updater.state;
  if (!state || state === 'unknown' || state === 'in-sync') return null;
  return (
    <p
      className={`mt-2 flex items-start gap-1.5 text-xs ${
        state === 'modified' ? 'text-destructive-ink' : 'text-muted-foreground'
      }`}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {state === 'modified' ? (
          <>
            <span className="font-medium">Updater script has local edits. </span>
            infra/updater/updater.sh differs from the copy it was installed with, so it will not
            self-refresh and this box keeps running older update logic. Restore it from the release
            (or delete infra/updater/updater.sh.release to re-adopt it).
          </>
        ) : (
          <>
            <span className="font-medium">Updater script is from an older release. </span>
            It refreshes itself at the end of the next successful update. Until then this box runs
            that release&apos;s update logic, which may not do everything the current one does.
          </>
        )}
      </span>
    </p>
  );
}

const PHASE_LABEL: Record<string, string> = {
  requested: 'Waiting for the updater to pick up the request…',
  pulling: 'Pulling the new image…',
  rolling: 'Rolling the stack onto it…',
};

// If the request sits unconsumed this long, the sidecar isn't running (it polls
// every 5s). Only enforced while phase is still 'requested' — once it advances to
// pulling/rolling the web container may be restarting and stalls are expected.
const PICKUP_TIMEOUT_MS = 60_000;

function UpdatesView({
  initialCheck,
  updaterAvailable,
  initialStatus,
  compose,
  build,
}: {
  initialCheck: UpdateCheck;
  updaterAvailable: boolean;
  initialStatus: UpdaterStatus | null;
  compose: ComposeStatus | null;
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
  // When the current polling run began — used to time out a request the sidecar
  // never picks up (a dead/parked updater).
  const pollStartRef = useRef<number>(0);
  // started_at of the run that was terminal when we asked for a new one. The
  // sidecar consumes request.json a beat before it writes the new status, and
  // in that gap the server has nothing to infer 'requested' from and replays
  // the PREVIOUS run's phase — so a healthy update briefly reads as the last
  // one's 'error' (stop polling, toast a failure) or 'done' (toast success
  // immediately). Identity, not timing, settles it: a terminal status still
  // carrying this started_at is the OLD run and gets ignored. Comparing
  // clocks would not work — the stamp is the sidecar's, the poll is ours.
  // Seeded on load too: a 'requested' phase is SYNTHESIZED by the server from
  // an unconsumed request.json over the old status, so its started_at is
  // already the previous run's — exactly the value to disregard.
  const priorStartedRef = useRef<string | null>(
    initialStatus?.phase === 'requested' ? initialStatus.startedAt : null,
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => {
    if (!updating) return;
    pollStartRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      try {
        const data = await apiFetch<{
          status: UpdaterStatus | null;
          log: string;
          version: string;
        }>('/api/updates/status', { cache: 'no-store' });
        setRestarting(false);
        // A terminal status the sidecar hasn't overwritten yet belongs to the
        // PREVIOUS run — keep waiting rather than reporting its outcome as
        // ours. Held back from setStatus too, so the view doesn't flash the
        // old failure under the spinner.
        const stale =
          (data.status?.phase === 'done' || data.status?.phase === 'error') &&
          !!data.status.startedAt &&
          data.status.startedAt === priorStartedRef.current;
        if (stale) return;
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
        } else if (data.status?.phase === 'unconfigured') {
          // The sidecar can't act (e.g. MANTLE_STACK_DIR missing). It will never
          // consume the request — surface it instead of spinning on "Working…".
          setUpdating(false);
          stopPolling();
          toast.error(
            data.status.error
              ? `Updater not configured: ${data.status.error}`
              : 'The updater is not configured on this host (set MANTLE_STACK_DIR in .env).',
          );
        } else if (
          data.status?.phase === 'requested' &&
          Date.now() - pollStartRef.current > PICKUP_TIMEOUT_MS
        ) {
          // Request written but never picked up — the sidecar isn't running.
          setUpdating(false);
          stopPolling();
          toast.error("The updater didn't pick up the request — is the sidecar running?");
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
    // Whatever run is terminal right now is the one to disregard from here on.
    priorStartedRef.current = status?.startedAt ?? null;
    setStatus((s) => (s ? { ...s, phase: 'requested', target, error: null } : s));
    setUpdating(true);
  }

  // 'requested' counts as busy in its own right, not just via `updating`:
  // that local flag only knows about updates THIS tab started, so a run
  // triggered elsewhere (another tab, another operator, a queued request the
  // sidecar hasn't reached) would otherwise render "Ready." over the top of
  // an update in flight — with the previous run's failure line under it.
  const busy =
    updating ||
    status?.phase === 'requested' ||
    status?.phase === 'pulling' ||
    status?.phase === 'rolling';
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
            {[build.sha, build.time ? build.time.slice(0, 10) : ''].filter(Boolean).join(' · ')}
          </span>
        </div>
        <ComposeLine compose={compose} />
        <UpdaterScriptLine compose={compose} />
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
          Checked {check.checkedAt.slice(0, 16).replace('T', ' ')} UTC against the GitHub releases
          of <code>crossworks-engineering/mantle</code>.
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
              The updater sidecar isn&apos;t available on this deployment, so one-click updates are
              off. Update from the stack directory instead:
            </p>
            <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs">
              docker compose pull && docker compose up -d --wait
            </pre>
            <p>
              The sidecar ships with the compose stack — it needs <code>MANTLE_STACK_DIR</code> set
              in <code>.env</code> (see docs/self-hosting.md).
            </p>
          </div>
        ) : busy ? (
          <div className="space-y-3">
            <p className="inline-flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {restarting
                ? 'Services are restarting — this page will reload onto the new version…'
                : (PHASE_LABEL[status?.phase ?? ''] ?? 'Working…')}
              {status?.target && <span className="text-muted-foreground">→ {status.target}</span>}
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
              Ready. Updating pulls the new image and rolls every service; database migrations apply
              automatically before the app restarts. Expect about a minute of downtime.
            </p>
            {status?.phase === 'error' && status.error && (
              <p className="text-destructive-ink">Last update failed: {status.error}</p>
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
              Pulls the new image and restarts every service (about a minute of downtime).
              Migrations apply automatically. A recent backup (Settings → Backups) is cheap
              insurance first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmUpdate}>Update now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
