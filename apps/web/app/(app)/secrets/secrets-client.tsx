'use client';

import { useEffect, useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Search } from 'lucide-react';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { SecretForm, emptySecretForm, KINDS, type Kind, type SecretBody } from './secret-form';
import { SecretDetail, type SecretRow } from './secret-detail';

type Selection = { mode: 'create' } | { mode: 'view'; id: string } | null;

type SecretsPage = { secrets: SecretRow[]; total: number; page: number; pageSize: number };

/** Outer query-gate so the page stays data-free. The URL params (kept by
 *  `useListNav`) key the query, so navigating refetches. */
export function SecretsClient({
  page,
  query,
  kind,
}: {
  page: number;
  query: string;
  kind: string;
}) {
  const secretsQuery = useQuery({
    queryKey: ['secrets', { query, kind, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set('q', query);
      if (kind && kind !== 'all') params.set('kind', kind);
      return apiFetch<SecretsPage>(`/api/secrets?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  if (secretsQuery.isPending && !secretsQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (secretsQuery.isError && !secretsQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Couldn&apos;t load secrets.</p>
        <Button variant="outline" size="sm" onClick={() => secretsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return <SecretsView data={secretsQuery.data} query={query} kind={kind} />;
}

function SecretsView({ data, query, kind }: { data: SecretsPage; query: string; kind: string }) {
  const { secrets: initialSecrets, total, page, pageSize } = data;
  const { pending: navPending, go } = useListNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [secrets, setSecrets] = useState(initialSecrets);
  const [searchInput, setSearchInput] = useState(query);
  const [pending, startTransition] = useTransition();
  const [sel, setSel] = useState<Selection>(() =>
    initialSecrets[0] ? { mode: 'view', id: initialSecrets[0].id } : { mode: 'create' },
  );

  const refresh = () => {
    startTransition(() => {
      void queryClient.invalidateQueries({ queryKey: ['secrets'] });
    });
  };

  // Re-seed on nav (search / filter / page) when the fetched page changes.
  useEffect(() => setSecrets(initialSecrets), [initialSecrets]);

  // Debounced search → URL (?q=); resets to page 1.
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() !== query) go({ q: searchInput.trim() || null, page: null });
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const filtering = !!query || kind !== 'all';
  const selected = sel?.mode === 'view' ? (secrets.find((s) => s.id === sel.id) ?? null) : null;

  const createSecret = async (body: SecretBody) => {
    let secret: SecretRow;
    try {
      ({ secret } = await apiSend<{ secret: SecretRow }>('/api/secrets', 'POST', body));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save secret');
      return;
    }
    setSecrets((prev) => [secret, ...prev]);
    setSel({ mode: 'view', id: secret.id });
    toast.success(`Saved “${secret.title}”`);
    refresh();
  };

  const onUpdated = (s: SecretRow) =>
    setSecrets((prev) => prev.map((x) => (x.id === s.id ? s : x)));

  const onDeleted = (id: string) => {
    setSecrets((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setSel(next[0] ? { mode: 'view', id: next[0].id } : { mode: 'create' });
      return next;
    });
    refresh();
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: secret list ────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Secrets
          </h2>
          <Button type="button" size="sm" onClick={() => setSel({ mode: 'create' })}>
            <Plus /> New
          </Button>
        </div>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search…"
              className="h-9 pl-8"
            />
          </div>
          <select
            value={kind}
            onChange={(e) =>
              go({ kind: e.target.value === 'all' ? null : e.target.value, page: null })
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Filter by kind"
          >
            <option value="all">All</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {secrets.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              {filtering ? (
                'No secrets match your search or filter.'
              ) : (
                <>
                  No secrets yet. Click <strong>New</strong> to add one.
                </>
              )}
            </p>
          ) : (
            secrets.map((s) => {
              const isSel = sel?.mode === 'view' && sel.id === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSel({ mode: 'view', id: s.id })}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    isSel && 'border-l-primary',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate text-sm font-medium">{s.title}</span>
                    <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {s.kind}
                    </span>
                  </div>
                  {(s.description || s.summary) && (
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                      {s.description || s.summary}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    {s.fieldCount > 0 && (
                      <span>
                        {s.fieldCount} field{s.fieldCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {s.hasNote && <span>· note</span>}
                    {s.tags.map((t) => (
                      <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                        {t}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })
          )}
        </div>
        <ListPager
          page={page}
          total={total}
          pageSize={pageSize}
          pending={navPending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* ── Right: create form | detail | empty ──────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {sel?.mode === 'create' ? (
          <div className="space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold">New secret</h2>
              <p className="text-xs text-muted-foreground">
                Stored sealed (AES-256-GCM). Only the title, description, and tags are indexed.
              </p>
            </div>
            <SecretForm
              initial={emptySecretForm()}
              submitLabel="Save secret"
              submitting={pending}
              onSubmit={createSecret}
              onCancel={() =>
                setSel(secrets[0] ? { mode: 'view', id: secrets[0].id } : { mode: 'create' })
              }
            />
          </div>
        ) : selected ? (
          <SecretDetail
            key={selected.id}
            secret={selected}
            onUpdated={onUpdated}
            onDeleted={() => onDeleted(selected.id)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a secret, or add a new one.
          </div>
        )}
      </div>
    </div>
  );
}
