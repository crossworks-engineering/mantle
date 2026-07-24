'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Network, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
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
import { cn } from '@mantle/web-ui/lib/utils';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { copyText } from '@mantle/web-ui/lib/secure-context-fallbacks';

type Peer = {
  id: string;
  displayName: string;
  baseUrl: string;
  status: string;
  enabled: boolean;
  hasOutboundToken: boolean;
  lastContactedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type Share = { id: string; nodeId: string; nodeType: string; title: string; createdAt: string };
type TypeShare = { id: string; nodeType: string; createdAt: string };
type NodeHit = { id: string; title: string; type: string };
type Selection = { mode: 'create' } | { mode: 'view'; id: string };

/** The categories a peer can subscribe to — mirrors PEER_SHAREABLE_TYPES
 *  (@mantle/content); the server enforces the allowlist. */
const CATEGORIES = [
  { type: 'page', label: 'Pages' },
  { type: 'note', label: 'Notes' },
  { type: 'file', label: 'Files' },
  { type: 'contact', label: 'Contacts' },
  { type: 'table', label: 'Tables' },
  { type: 'event', label: 'Events' },
  { type: 'task', label: 'Tasks' },
] as const;

/** Reveal-once box for a freshly-minted inbound token. */
function TokenReveal({ token, onDone }: { token: string; onDone: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(token);
    setCopied(true);
    toast.success('Token copied');
  };
  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium">Your token for them — shown once</p>
      <p className="text-xs text-muted-foreground">
        Send this to the peer: they paste it on their side so their Mantle can authenticate to
        yours. We store only its hash — you can&apos;t see it again (rotate to mint a new one).
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {token}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <Button type="button" size="sm" onClick={onDone}>
        I&apos;ve saved it
      </Button>
    </div>
  );
}

/** Outer query-gate so the page stays data-free. */
export function PeersClient() {
  const peersQuery = useQuery({
    queryKey: ['peers'],
    queryFn: () => apiFetch<{ peers: Peer[] }>('/api/peers'),
  });
  if (peersQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (peersQuery.isError && !peersQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
        <p>Couldn&apos;t load peers.</p>
        <Button variant="outline" size="sm" onClick={() => peersQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <PeersView initialPeers={peersQuery.data.peers} />;
}

/** Once peers are loaded, this owns the working list (seeds from the fetch,
 *  then mutates locally as peers are added/edited/removed). */
function PeersView({ initialPeers }: { initialPeers: Peer[] }) {
  const [peers, setPeers] = useState<Peer[]>(initialPeers);
  // Deep link: /settings/peers?selected=<id-or-display-name> preselects that
  // peer (initial state only — selection stays client-state after).
  const searchParams = useSearchParams();
  const [sel, setSel] = useState<Selection>(() => {
    const want = searchParams.get('selected')?.trim();
    const hit = want
      ? initialPeers.find((p) => p.id === want || p.displayName === want)
      : undefined;
    if (hit) return { mode: 'view', id: hit.id };
    return initialPeers[0] ? { mode: 'view', id: initialPeers[0].id } : { mode: 'create' };
  });
  const [reveal, setReveal] = useState<string | null>(null);

  const selected = sel.mode === 'view' ? (peers.find((p) => p.id === sel.id) ?? null) : null;

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: peer list ───────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Peers
          </h2>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setReveal(null);
              setSel({ mode: 'create' });
            }}
          >
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {peers.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No peers yet. Click <strong>New</strong> to connect another Mantle.
            </p>
          ) : (
            peers.map((p) => {
              const isSel = sel.mode === 'view' && sel.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setReveal(null);
                    setSel({ mode: 'view', id: p.id });
                  }}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    isSel ? 'border-l-primary' : 'border-l-border',
                    !p.enabled && 'opacity-60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Network className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{p.displayName}</span>
                    <span
                      className={cn(
                        'ml-auto size-2 shrink-0 rounded-full',
                        p.enabled && p.status === 'active'
                          ? 'bg-primary'
                          : p.enabled && p.status === 'pending'
                            ? 'bg-chart-4'
                            : 'bg-muted-foreground/40',
                      )}
                      aria-label={
                        p.enabled
                          ? p.status === 'pending'
                            ? 'awaiting their token'
                            : p.status
                          : 'disabled'
                      }
                    />
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{p.baseUrl}</div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right: create | detail ────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {sel.mode === 'create' ? (
          <CreatePeer
            onCreated={(peer, inboundToken) => {
              setPeers((p) => [peer, ...p]);
              setReveal(inboundToken);
              setSel({ mode: 'view', id: peer.id });
            }}
          />
        ) : selected ? (
          <PeerDetail
            key={selected.id}
            peer={selected}
            revealToken={reveal}
            onClearReveal={() => setReveal(null)}
            onChanged={(patch) =>
              setPeers((list) => list.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)))
            }
            onRevealNew={(t) => setReveal(t)}
            onDeleted={() => {
              const next = peers.filter((p) => p.id !== selected.id);
              setPeers(next);
              setReveal(null);
              setSel(next[0] ? { mode: 'view', id: next[0].id } : { mode: 'create' });
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a peer, or add a new one.
          </div>
        )}
      </div>
    </div>
  );
}

function CreatePeer({ onCreated }: { onCreated: (peer: Peer, inboundToken: string) => void }) {
  const toast = useToast();
  const [displayName, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [outboundToken, setOutbound] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !baseUrl.trim()) {
      toast.error('Name and base URL are required');
      return;
    }
    setPending(true);
    try {
      const { peer, inboundToken } = await apiSend<{ peer: Peer; inboundToken: string }>(
        '/api/peers',
        'POST',
        {
          displayName,
          baseUrl,
          ...(outboundToken.trim() ? { outboundToken: outboundToken.trim() } : {}),
        },
      );
      toast.success(`Added ${peer.displayName}`);
      onCreated(peer, inboundToken);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add peer');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <Network className="size-5 text-primary" aria-hidden />
        <h2 className="text-lg font-semibold">Connect a Mantle</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Pairing uses <strong>two tokens, one per direction</strong>. Step 1 — add the peer with just
        a name and URL: we mint <em>your</em> token to send them (shown once). Step 2 — paste the
        token <em>they</em> send you, here or later on the peer&apos;s page. Neither side needs the
        other to go first.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="peer-name">Display name</Label>
          <Input
            id="peer-name"
            value={displayName}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Her Mantle"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="peer-url">Base URL</Label>
          <Input
            id="peer-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://her-mantle.example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="peer-token">Their token — optional for now</Label>
          <Input
            id="peer-token"
            value={outboundToken}
            onChange={(e) => setOutbound(e.target.value)}
            placeholder="mtlpeer_… (leave empty if they haven't sent it yet)"
          />
          <p className="text-xs text-muted-foreground">
            Used to query them; sealed at rest. Without it the peer is added as “awaiting their
            token” — they can already query you, and you paste theirs when it arrives.
          </p>
        </div>
        <div className="flex justify-end border-t border-border pt-3">
          <SubmitButton pending={pending}>Add peer</SubmitButton>
        </div>
      </form>
    </div>
  );
}

function PeerDetail({
  peer,
  revealToken,
  onClearReveal,
  onChanged,
  onRevealNew,
  onDeleted,
}: {
  peer: Peer;
  revealToken: string | null;
  onClearReveal: () => void;
  onChanged: (patch: Partial<Peer>) => void;
  onRevealNew: (token: string) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [typeShares, setTypeShares] = useState<TypeShare[]>([]);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<NodeHit[]>([]);
  const [newOutbound, setNewOutbound] = useState('');

  const loadShares = useCallback(async () => {
    try {
      const { shares, typeShares, typeCounts } = await apiFetch<{
        shares: Share[];
        typeShares: TypeShare[];
        typeCounts: Record<string, number>;
      }>(`/api/peers/${peer.id}/shares`);
      setShares(shares ?? []);
      setTypeShares(typeShares ?? []);
      setTypeCounts(typeCounts ?? {});
    } catch {
      /* leave the existing list on a transient read failure */
    }
  }, [peer.id]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  // Debounced node search for the grant picker.
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const h = setTimeout(async () => {
      try {
        const { nodes } = await apiFetch<{ nodes: NodeHit[] }>(
          `/api/peers/nodes?q=${encodeURIComponent(q.trim())}`,
        );
        setHits(nodes ?? []);
      } catch {
        setHits([]);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await apiSend(`/api/peers/${peer.id}`, 'PATCH', { enabled });
      onChanged({
        enabled,
        status: enabled ? (peer.hasOutboundToken ? 'active' : 'pending') : 'revoked',
      });
    } catch {
      toast.error('Could not update');
    }
  };

  const rotate = async () => {
    try {
      const { inboundToken } = await apiSend<{ inboundToken: string }>(
        `/api/peers/${peer.id}/rotate`,
        'POST',
      );
      onRevealNew(inboundToken);
      toast.success('New inbound token minted');
    } catch {
      toast.error('Could not rotate');
    }
  };

  const saveOutbound = async () => {
    if (!newOutbound.trim()) return;
    try {
      await apiSend(`/api/peers/${peer.id}`, 'PATCH', { outboundToken: newOutbound.trim() });
      setNewOutbound('');
      onChanged({
        hasOutboundToken: true,
        ...(peer.status === 'pending' ? { status: 'active' } : {}),
      });
      toast.success(
        peer.status === 'pending' ? 'Pairing complete — peer is active' : 'Outbound token updated',
      );
    } catch {
      toast.error('Could not update token');
    }
  };

  const grant = async (nodeId: string) => {
    try {
      await apiSend(`/api/peers/${peer.id}/shares`, 'POST', { nodeId });
      setQ('');
      setHits([]);
      await loadShares();
    } catch {
      toast.error('Could not grant');
    }
  };

  const toggleCategory = async (nodeType: string, on: boolean) => {
    // Optimistic flip so the Switch doesn't lag; reload reconciles, revert on error.
    setTypeShares((list) =>
      on
        ? [...list, { id: `optimistic-${nodeType}`, nodeType, createdAt: new Date().toISOString() }]
        : list.filter((t) => t.nodeType !== nodeType),
    );
    try {
      if (on) {
        await apiSend(`/api/peers/${peer.id}/shares`, 'POST', { nodeType });
      } else {
        await apiSend(`/api/peers/${peer.id}/shares?nodeType=${nodeType}`, 'DELETE');
      }
      await loadShares();
    } catch {
      setTypeShares((list) =>
        on
          ? list.filter((t) => t.nodeType !== nodeType)
          : [
              ...list,
              { id: `optimistic-${nodeType}`, nodeType, createdAt: new Date().toISOString() },
            ],
      );
      toast.error('Could not update category share');
    }
  };

  const revoke = async (nodeId: string) => {
    try {
      await apiSend(`/api/peers/${peer.id}/shares?nodeId=${nodeId}`, 'DELETE');
      await loadShares();
    } catch {
      toast.error('Could not revoke');
    }
  };

  const confirmDelete = async () => {
    setDeleteOpen(false);
    try {
      await apiSend(`/api/peers/${peer.id}`, 'DELETE');
      toast.success(`Removed ${peer.displayName}`);
      onDeleted();
    } catch {
      toast.error('Could not delete peer');
    }
  };

  const grantedIds = new Set(shares.map((s) => s.nodeId));

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold">{peer.displayName}</h2>
          <p className="truncate text-sm text-muted-foreground">{peer.baseUrl}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Enabled</span>
            <Switch checked={peer.enabled} onCheckedChange={toggleEnabled} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        <div>
          Status:{' '}
          <span className="font-medium text-foreground">
            {peer.enabled
              ? peer.status === 'pending'
                ? 'awaiting their token'
                : peer.status
              : 'disabled'}
          </span>
        </div>
        <div>Added: {formatDateTime(peer.createdAt)}</div>
        <div>
          Last called them: {peer.lastContactedAt ? formatDateTime(peer.lastContactedAt) : '—'}
        </div>
        <div>Last seen from them: {peer.lastSeenAt ? formatDateTime(peer.lastSeenAt) : '—'}</div>
      </div>

      {revealToken && <TokenReveal token={revealToken} onDone={onClearReveal} />}

      {/* Tokens */}
      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <p className="inline-flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4" /> Tokens
          </p>
          <Button type="button" size="sm" variant="outline" onClick={rotate}>
            <RefreshCw /> Rotate inbound
          </Button>
        </div>
        {!peer.hasOutboundToken && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Finish pairing:</span> paste the token{' '}
            {peer.displayName} sends you below. Until then they can query you, but you can&apos;t
            query them.
          </p>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={newOutbound}
            onChange={(e) => setNewOutbound(e.target.value)}
            placeholder={
              peer.hasOutboundToken
                ? 'Update their token (outbound)…'
                : 'Paste their token (outbound)…'
            }
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={saveOutbound}
            disabled={!newOutbound.trim()}
          >
            Save
          </Button>
        </div>
      </div>

      {/* Category grants — standing per-type subscriptions */}
      <div className="space-y-3 rounded-md border border-border p-3">
        <p className="text-sm font-medium">Share whole categories</p>
        <p className="text-xs text-muted-foreground">
          A category switch shares every item of that type with {peer.displayName} —{' '}
          <span className="font-medium text-foreground">including ones you create later</span>. Turn
          it off to go back to cherry-picking below.
        </p>
        <ul className="divide-y divide-border">
          {CATEGORIES.map((c) => {
            const on = typeShares.some((t) => t.nodeType === c.type);
            const count = typeCounts[c.type] ?? 0;
            return (
              <li key={c.type} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{c.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {count}{' '}
                    {count === 1 ? c.label.toLowerCase().replace(/s$/, '') : c.label.toLowerCase()}
                    {on && <> · includes future {c.label.toLowerCase()}</>}
                  </p>
                </div>
                <Switch
                  checked={on}
                  onCheckedChange={(v) => toggleCategory(c.type, v)}
                  aria-label={`Share all ${c.label.toLowerCase()}`}
                />
              </li>
            );
          })}
        </ul>
      </div>

      {/* Grants */}
      <div className="space-y-3">
        <p className="text-sm font-medium">Shared with {peer.displayName}</p>
        <p className="text-xs text-muted-foreground">
          Beyond any categories above, only these individually shared nodes are visible to this
          peer. Everything else stays private.
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a note, file, contact… to share"
            className="pl-8"
          />
        </div>
        {hits.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {hits.map((h) => (
              <li key={h.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {h.type}
                </span>
                <span className="min-w-0 flex-1 truncate">{h.title}</span>
                {grantedIds.has(h.id) ? (
                  <span className="text-xs text-muted-foreground">shared</span>
                ) : (
                  <Button type="button" size="sm" variant="outline" onClick={() => grant(h.id)}>
                    Share
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {shares.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
            {typeShares.length > 0
              ? 'No individually shared nodes — this peer sees the categories above.'
              : 'Nothing shared yet — this peer can read nothing.'}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {shares.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {s.nodeType}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => revoke(s.nodeId)}
                  aria-label="Revoke"
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{peer.displayName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Both tokens stop working immediately and all grants are dropped. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
