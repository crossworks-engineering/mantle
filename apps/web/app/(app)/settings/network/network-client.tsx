'use client';

import { useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Radio, CircleDot, ArrowRight, Power, PowerOff, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import type { TailnetResult } from '@/lib/tailscale';
import type { TailscaleConfigSummary } from '@/lib/tailscale-config';

type NetworkData = { status: TailnetResult; config: TailscaleConfigSummary | null };
type NetworkResult = { ok: boolean; message: string };

/** Outer query-gate so the page stays data-free. */
export function NetworkClient() {
  const networkQuery = useQuery({
    queryKey: ['network'],
    queryFn: () => apiFetch<NetworkData>('/api/network'),
  });
  if (networkQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (networkQuery.isError && !networkQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
        <p>Couldn&apos;t load network status.</p>
        <Button variant="outline" size="sm" onClick={() => networkQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <NetworkView status={networkQuery.data.status} config={networkQuery.data.config} />;
}

function NetworkView({
  status,
  config,
}: {
  status: TailnetResult;
  config: TailscaleConfigSummary | null;
}) {
  const connected = status.available && status.backendState === 'Running';
  const sidecarUp = status.available; // tailscaled reachable (socket present)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-1">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Radio className="size-5 text-muted-foreground" />
          Local network (Tailscale)
        </h1>
        <p className="text-sm text-muted-foreground">
          Reach a box you own — a home GPU or LAN server behind NAT — by name, with no
          port-forwarding or public IPs. Once it&apos;s on your tailnet, point a chat or vision
          route&apos;s <strong>Base URL</strong> at its MagicDNS name and flip{' '}
          <strong>Reach via Tailscale</strong> on (Agents / AI workers pages).
        </p>
      </header>

      {/* ── Status ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Connection</CardTitle>
            {status.available ? (
              <Badge variant={connected ? 'default' : 'secondary'}>{status.backendState}</Badge>
            ) : (
              <Badge variant="outline">Not running</Badge>
            )}
          </div>
          <CardDescription>
            {connected
              ? 'Mantle is on your tailnet. The peers below are reachable by name.'
              : status.available
                ? `Sidecar reachable but not connected (${status.backendState}). Save an auth key below and click Activate.`
                : status.reason}
          </CardDescription>
        </CardHeader>
        {status.available && status.self && (
          <CardContent className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">This node:</span>
              <code className="font-mono">{status.self.dnsName || status.self.hostName}</code>
              {status.magicDNSSuffix && (
                <Badge variant="outline" className="font-mono text-xs">
                  {status.magicDNSSuffix}
                </Badge>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* ── Activate from the UI ─────────────────────────────────────── */}
      <ActivateCard status={status} config={config} connected={connected} sidecarUp={sidecarUp} />

      {/* ── Peers (reachable boxes) ──────────────────────────────────── */}
      {status.available && status.peers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reachable devices</CardTitle>
            <CardDescription>
              Use a device&apos;s name as the route Base URL host, e.g.{' '}
              <code className="font-mono">http://&lt;name&gt;:11434/v1</code> (Ollama) or{' '}
              <code className="font-mono">:1234/v1</code> (LM Studio).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {status.peers.map((p) => (
              <div
                key={p.dnsName || p.hostName}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <CircleDot
                    className={
                      p.online
                        ? 'size-3.5 shrink-0 text-emerald-500'
                        : 'size-3.5 shrink-0 text-muted-foreground/40'
                    }
                  />
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm">{p.dnsName || p.hostName}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.online ? 'online' : 'offline'}
                      {p.os ? ` · ${p.os}` : ''}
                      {p.ips[0] ? ` · ${p.ips[0]}` : ''}
                    </div>
                  </div>
                </div>
                {p.dnsName && <CopyButton value={p.dnsName} label="Copy name" />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ActivateCard({
  status,
  config,
  connected,
  sidecarUp,
}: {
  status: TailnetResult;
  config: TailscaleConfigSummary | null;
  connected: boolean;
  sidecarUp: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  // Show the key form when nothing's stored, or when the user clicks "Replace".
  const [editing, setEditing] = useState(config === null);
  const [authKey, setAuthKey] = useState('');
  const [hostname, setHostname] = useState(config?.hostname ?? 'mantle');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['network'] });

  // Poll status a few times so the Connection badge catches up after the async
  // tailscaled login (a 2xx from activate ≠ joined yet).
  function pollStatus() {
    [2000, 5000, 9000, 14000, 20000].forEach((ms) => setTimeout(refresh, ms));
  }

  function run(fn: () => Promise<NetworkResult>, opts?: { poll?: boolean }) {
    startTransition(async () => {
      try {
        const r = await fn();
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        refresh();
        if (r.ok && opts?.poll) pollStatus();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Request failed');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Activate Tailscale</CardTitle>
        <CardDescription>
          Paste an auth key once — it&apos;s sealed in the vault (AES-256-GCM) like your API keys —
          then activate or deactivate the tailnet right here. No SSH, no editing{' '}
          <code className="font-mono">.env</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!editing && config && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">Saved key</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {config.masked}
            </code>
            <span className="text-muted-foreground">· device</span>
            <code className="font-mono text-xs">{config.hostname}</code>
          </div>
        )}

        {editing && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ts-authkey">Auth key</Label>
              <Input
                id="ts-authkey"
                type="text"
                autoComplete="off"
                placeholder="tskey-auth-xxxxxxxxxxxx"
                value={authKey}
                onChange={(e) => setAuthKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Generate one in the{' '}
                <a
                  href="https://login.tailscale.com/admin/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Tailscale admin console
                </a>
                . Shown once, then stored masked.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ts-hostname">Device name</Label>
              <Input
                id="ts-hostname"
                placeholder="mantle"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || !authKey.trim()}
                onClick={() =>
                  run(async () => {
                    const r = await apiSend<NetworkResult>('/api/network/key', 'POST', {
                      authKey,
                      hostname,
                    });
                    if (r.ok) {
                      setAuthKey('');
                      setEditing(false);
                    }
                    return r;
                  })
                }
              >
                {pending ? <Loader2 className="animate-spin" /> : null}
                Save key
              </Button>
              {config && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}

        {!editing && config && (
          <div className="flex flex-wrap gap-2">
            {connected ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() => apiSend<NetworkResult>('/api/network/deactivate', 'POST'), {
                    poll: true,
                  })
                }
              >
                {pending ? <Loader2 className="animate-spin" /> : <PowerOff />}
                Deactivate
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={pending || !sidecarUp}
                title={
                  sidecarUp
                    ? undefined
                    : 'The tailscale sidecar is not running (dev, or profile off)'
                }
                onClick={() =>
                  run(() => apiSend<NetworkResult>('/api/network/activate', 'POST'), { poll: true })
                }
              >
                {pending ? <Loader2 className="animate-spin" /> : <Power />}
                Activate
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(true)}>
              Replace key
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = await apiSend<NetworkResult>('/api/network/key', 'DELETE');
                  if (r.ok) setEditing(true);
                  return r;
                })
              }
            >
              Remove
            </Button>
          </div>
        )}

        {!sidecarUp && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            The tailscale sidecar isn&apos;t running here
            {!status.available ? ` (${status.reason})` : ''}. Saving a key still works; Activate
            takes effect on the deployed VPS, where the sidecar runs alongside the app.
          </p>
        )}

        <div className="pt-1">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/network/connect">
              Connect a device — step-by-step
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
