'use client';

/**
 * The CLI-sandboxes surface. Master-detail: left = the owner's sandboxes
 * (URL-driven selection, live status merged server-side); right = the selected
 * sandbox's facts + its recent command history (the `sandbox_exec` trace
 * steps), plus the operator Stop / Remove actuators. Remove mirrors
 * `sandbox_rm`'s contract: the container goes, the /files work directory is
 * preserved on the host unless the owner explicitly opts into purging it.
 */
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import { Checkbox } from '@mantle/web-ui/ui/checkbox';
import { Label } from '@mantle/web-ui/ui/label';
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
} from '@mantle/web-ui/ui/alert-dialog';
import { useToast } from '@mantle/web-ui/ui/toast';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { timeAgo } from '@mantle/web-ui/forum-meta';
import { useListNav } from '@/lib/use-list-nav';
import { cn } from '@mantle/web-ui/lib/utils';

type SandboxEntry = {
  id: string;
  name: string;
  description: string | null;
  image: string;
  network: 'full' | 'none';
  status: 'running' | 'stopped';
  lastUsedAt: string;
  createdAt: string;
};

type SandboxesPayload = {
  enabled: boolean;
  disk: { usedBytes: number | null; budgetBytes: number } | null;
  sandboxes: SandboxEntry[];
};

type CommandEntry = {
  id: string;
  traceId: string;
  status: string;
  startedAt: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
};

type SandboxDetailPayload = { sandbox: SandboxEntry; commands: CommandEntry[] };

const STATUS_CLASS: Record<string, string> = {
  running: 'text-success-ink',
  stopped: 'text-muted-foreground',
};

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Stop actuator — same semantics as `sandbox_stop`: packages + /files kept,
 *  the next exec restarts the container. */
function StopButton({ sandbox, onDone }: { sandbox: SandboxEntry; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || sandbox.status === 'stopped'}
      onClick={() => {
        setBusy(true);
        apiSend<{ ok: boolean }>(`/api/sandboxes/${sandbox.id}/stop`, 'POST')
          .then(() => {
            toast.success(`Sandbox '${sandbox.name}' stopped`);
            onDone();
          })
          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      Stop
    </Button>
  );
}

/** Remove actuator — `sandbox_rm` from the UI. The dialog is explicit about
 *  the contract: work in /files is preserved on the host; deleting it too is
 *  a separate, opt-in checkbox. */
function RemoveButton({ sandbox, onDone }: { sandbox: SandboxEntry; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [purge, setPurge] = useState(false);
  return (
    <AlertDialog onOpenChange={(open) => open && setPurge(false)}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive-ink" disabled={busy}>
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove sandbox &lsquo;{sandbox.name}&rsquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            The container is deleted (installed packages and all) and the name is freed. Work in its
            /files directory is <strong>preserved on the host</strong> — removing the sandbox never
            touches it unless you also opt in below.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <Checkbox
            id="purge-files"
            checked={purge}
            onCheckedChange={(v) => setPurge(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor="purge-files" className="text-sm font-normal leading-snug">
            Also delete the /files work directory — <strong>irreversible</strong>. Everything this
            sandbox produced is gone for good.
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep sandbox</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              setBusy(true);
              apiSend<{ removed: string }>(
                `/api/sandboxes/${sandbox.id}${purge ? '?purge=1' : ''}`,
                'DELETE',
              )
                .then(() => {
                  toast.success(
                    purge
                      ? `Sandbox '${sandbox.name}' removed, files deleted`
                      : `Sandbox '${sandbox.name}' removed — files preserved`,
                  );
                  onDone();
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {purge ? 'Remove and delete files' : 'Remove sandbox'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function SandboxDetail({
  sandboxId,
  onChanged,
  onRemoved,
}: {
  sandboxId: string;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: ['sandbox', sandboxId],
    queryFn: () => apiFetch<SandboxDetailPayload>(`/api/sandboxes/${sandboxId}`),
    // No realtime channel for sandboxes — a modest poll keeps the command
    // history and idle-stop status honest while the pane is open.
    refetchInterval: 15_000,
  });

  if (detailQuery.isError) {
    return (
      <p className="p-6 text-sm text-destructive-ink">
        {detailQuery.error instanceof Error ? detailQuery.error.message : 'Could not load sandbox.'}
      </p>
    );
  }
  if (detailQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading sandbox…
      </div>
    );
  }
  const { sandbox, commands } = detailQuery.data;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="font-mono text-lg font-semibold">{sandbox.name}</h2>
        <span className={cn('font-mono text-xs uppercase', STATUS_CLASS[sandbox.status] ?? '')}>
          {sandbox.status}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <StopButton sandbox={sandbox} onDone={onChanged} />
          <RemoveButton sandbox={sandbox} onDone={onRemoved} />
        </span>
      </div>
      {sandbox.description && (
        <p className="text-sm text-muted-foreground">{sandbox.description}</p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4">
        <Fact label="Image" value={sandbox.image} />
        <Fact label="Network" value={sandbox.network === 'full' ? 'full egress' : 'offline'} />
        <Fact label="Created" value={new Date(sandbox.createdAt).toLocaleString()} />
        <Fact label="Last used" value={new Date(sandbox.lastUsedAt).toLocaleString()} />
      </dl>

      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Command history
        </h3>
        {commands.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
            No commands yet. History appears here as the agent runs <code>sandbox_exec</code> in
            this sandbox.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {commands.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-card px-3 py-2">
                <code className="block break-all font-mono text-xs">{c.command}</code>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {c.timedOut ? (
                    <span className="text-destructive-ink">timed out</span>
                  ) : c.exitCode == null ? (
                    <span>exit —</span>
                  ) : (
                    <span className={cn(c.exitCode !== 0 && 'text-destructive-ink')}>
                      exit {c.exitCode}
                    </span>
                  )}
                  <span>{fmtDuration(c.durationMs)}</span>
                  <span className="ml-auto">{timeAgo(c.startedAt)}</span>
                  <a
                    href={`/traces?selected=${c.traceId}`}
                    className="text-primary-ink hover:underline"
                  >
                    trace
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Centered explainer for boxes that haven't opted into the feature. */
function NotEnabled() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-lg border border-border bg-card p-6 text-center">
        <h2 className="text-base font-semibold">Sandboxes are not enabled on this box</h2>
        <p className="text-sm text-muted-foreground">
          CLI sandboxes are isolated, persistent containers the coder agent works in — enabled per
          box via the <code>sandboxes</code> compose profile. To turn them on, set{' '}
          <code>SANDBOXD_TOKEN</code> and <code>MANTLE_SANDBOXES_HOST_DIR</code> in the box&rsquo;s
          env and add <code>COMPOSE_PROFILES=sandboxes</code>, then redeploy.
        </p>
      </div>
    </div>
  );
}

export function SandboxesClient() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { go } = useListNav();
  const sandboxParam = searchParams.get('sandbox');

  const listQuery = useQuery({
    queryKey: ['sandboxes'],
    queryFn: () => apiFetch<SandboxesPayload>('/api/sandboxes'),
    refetchInterval: 30_000,
  });

  if (listQuery.isError) {
    return (
      <p className="p-6 text-sm text-destructive-ink">
        {listQuery.error instanceof Error ? listQuery.error.message : 'Could not load sandboxes.'}
      </p>
    );
  }
  if (listQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading sandboxes…
      </div>
    );
  }

  const { enabled, disk, sandboxes } = listQuery.data;
  if (!enabled) return <NotEnabled />;

  // Auto-select the first row when the URL names none (no history push).
  const selected = sandboxParam ?? sandboxes[0]?.id ?? null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
    void queryClient.invalidateQueries({ queryKey: ['sandbox'] });
  };

  return (
    <div className="h-full md:grid md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: sandbox list ───────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Sandboxes
          </h2>
          <span className="text-xs text-muted-foreground tabular-nums">{sandboxes.length}</span>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {sandboxes.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No sandboxes yet. The coder agent creates one with <code>sandbox_create</code> when it
              needs an isolated terminal.
            </p>
          ) : (
            sandboxes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go({ sandbox: s.id })}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                  selected === s.id && 'border-l-primary',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium">{s.name}</span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider',
                      STATUS_CLASS[s.status] ?? 'text-muted-foreground',
                    )}
                  >
                    {s.status}
                  </span>
                </div>
                {s.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.description}</p>
                )}
                <div className="mt-0.5 text-xs text-muted-foreground">
                  used {timeAgo(s.lastUsedAt)}
                </div>
              </button>
            ))
          )}
        </div>
        {disk && disk.usedBytes != null && (
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Disk: {fmtBytes(disk.usedBytes)} of {fmtBytes(disk.budgetBytes)} used
          </div>
        )}
      </div>

      {/* ── Right: sandbox detail ────────────────────────────────────── */}
      <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <SandboxDetail
            sandboxId={selected}
            onChanged={refresh}
            onRemoved={() => {
              // The deleted id must leave the URL or the detail pane 404s.
              go({ sandbox: null });
              refresh();
            }}
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Select a sandbox to inspect it.</p>
        )}
      </div>
    </div>
  );
}
