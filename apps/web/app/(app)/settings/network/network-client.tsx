'use client';

import { useState } from 'react';
import { Radio, Copy, Check, CircleDot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import type { TailnetResult } from '@/lib/tailscale';

/** A tiny copy-to-clipboard button that flips to a check for a moment. */
function CopyButton({ value, label }: { value: string; label?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error('Could not copy to clipboard');
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  );
}

const SNIPPET = `# .env (next to docker-compose.yml)
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx   # generate at https://login.tailscale.com/admin/settings/keys
TS_HOSTNAME=mantle-vps               # this node's name on your tailnet

# then bring the tailnet sidecar up:
docker compose --profile tailnet up -d`;

export function NetworkClient({ status }: { status: TailnetResult }) {
  const connected = status.available && status.backendState === 'Running';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-1">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Radio className="size-5 text-muted-foreground" />
          Local network (Tailscale)
        </h1>
        <p className="text-sm text-muted-foreground">
          Reach a box you own — a home GPU or LAN server behind NAT — by name, with no
          port-forwarding or public IPs. Once it&apos;s on your tailnet, point a chat or
          vision route&apos;s <strong>Base URL</strong> at its MagicDNS name and flip{' '}
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
                ? `Sidecar reachable but not connected (${status.backendState}). Check TS_AUTHKEY and the Tailscale admin console.`
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

      {/* ── Setup (env-based) ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set it up</CardTitle>
          <CardDescription>
            The auth key is an infrastructure secret, so it lives in your environment — not in
            this UI. Three steps, ~2 minutes:
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="ml-4 list-decimal space-y-1.5 text-muted-foreground">
            <li>
              On the box you want to reach: install Tailscale, sign in (free), and start your
              model server (Ollama / LM Studio).
            </li>
            <li>
              Generate an <strong>auth key</strong> in the{' '}
              <a
                href="https://login.tailscale.com/admin/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Tailscale admin console
              </a>
              .
            </li>
            <li>
              Put it in <code className="font-mono">.env</code> and bring the sidecar up (below).
              This page then shows the connection + your devices.
            </li>
          </ol>
          <div className="relative">
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 pr-20 text-xs leading-relaxed">
              <code>{SNIPPET}</code>
            </pre>
            <div className="absolute right-2 top-2">
              <CopyButton value={SNIPPET} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The <code className="font-mono">tailnet</code> profile is off by default, so a normal{' '}
            <code className="font-mono">docker compose up</code> never starts it — nothing changes
            until you opt in. Device, key, and ACL management all live in the Tailscale console;
            Mantle just reads the connection.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
