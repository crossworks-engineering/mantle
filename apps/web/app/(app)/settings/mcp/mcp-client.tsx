'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, Plug, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
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
import { useToast } from '@/components/ui/toast';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { formatDateTime } from '@/lib/format-datetime';
import { cn } from '@/lib/utils';

type ConnectedClient = {
  id: string;
  clientName: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
  activeTokens: number;
};
type McpSettings = { enabled: boolean; connectorUrl: string; clients: ConnectedClient[] };
type CheckResult = { ok: boolean; status: number; message: string };

export function McpSettingsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['mcp-settings'],
    queryFn: () => apiFetch<McpSettings>('/api/mcp-settings'),
  });

  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['mcp-settings'] });

  async function setEnabled(next: boolean) {
    setToggling(true);
    try {
      await apiSend('/api/mcp-settings', 'PATCH', { enabled: next });
      setCheck(null);
      await invalidate();
      toast.success(next ? 'Remote MCP enabled' : 'Remote MCP disabled');
    } catch {
      toast.error('Could not update');
    } finally {
      setToggling(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select and copy manually');
    }
  }

  async function runCheck() {
    setChecking(true);
    setCheck(null);
    try {
      setCheck(await apiSend<CheckResult>('/api/mcp-status', 'POST'));
    } catch {
      setCheck({ ok: false, status: 0, message: 'Check failed to run.' });
    } finally {
      setChecking(false);
    }
  }

  async function disconnect(id: string) {
    setDisconnecting(id);
    try {
      await apiSend(`/api/mcp-clients/${id}`, 'DELETE');
      await invalidate();
      toast.success('Disconnected');
    } catch {
      toast.error('Could not disconnect');
    } finally {
      setDisconnecting(null);
    }
  }

  if (query.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return <div className="p-6 text-sm text-destructive">Could not load MCP settings.</div>;
  }

  const { enabled, connectorUrl, clients } = query.data;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-4 md:p-6">
        {/* Connector card */}
        <section className="rounded-xl border border-border bg-card">
          <div className="flex items-start justify-between gap-4 border-b border-border p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-accent p-2 text-accent-foreground">
                <Plug className="size-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Remote MCP connector</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Expose this brain&apos;s tools as a claude.ai custom connector — add it on the web,
                  desktop, or mobile with no SSH or config files.
                </p>
              </div>
            </div>
            <Switch
              checked={enabled}
              disabled={toggling}
              onCheckedChange={setEnabled}
              aria-label="Enable remote MCP"
            />
          </div>

          {enabled ? (
            <div className="space-y-4 p-4 md:p-5">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Connector URL</label>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
                    {connectorUrl}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => copyUrl(connectorUrl)}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">How to connect</p>
                <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
                  <li>In claude.ai, open Settings → Connectors → Add custom connector.</li>
                  <li>Paste the URL above.</li>
                  <li>Sign in to this Mantle and approve access when prompted.</li>
                </ol>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" onClick={runCheck} disabled={checking}>
                  {checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                  Check endpoint
                </Button>
                {check && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 text-sm',
                      check.ok ? 'text-foreground' : 'text-destructive',
                    )}
                  >
                    {check.ok ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
                    {check.message}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground md:p-5">
              Off by default — the connector puts your tool surface on the public internet (behind
              OAuth sign-in + consent). Turn it on to get a URL you can add to claude.ai.
            </div>
          )}
        </section>

        {/* Connected clients */}
        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold">Connected clients</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Apps that have signed in and hold a live token. Disconnect to revoke access immediately.
            </p>
          </div>
          {clients.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground md:p-5">No connected clients yet.</div>
          ) : (
            <ul className="divide-y divide-border">
              {clients.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-4 p-4 md:px-5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.clientName || 'Unnamed client'}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Connected {formatDateTime(c.connectedAt)}
                      {c.lastUsedAt ? ` · last used ${formatDateTime(c.lastUsedAt)}` : ' · not used yet'}
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={disconnecting === c.id}
                      >
                        {disconnecting === c.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        Disconnect
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Disconnect this client?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {c.clientName || 'This client'} will lose access immediately. It can
                          reconnect later by signing in again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => disconnect(c.id)}
                        >
                          Disconnect
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
