'use client';

/**
 * One /team workspace section: the card list of team-visible shares of one
 * type (left, mirroring the owner screens' master-detail list pane) and a
 * read-only reader for the selected item (right) — the /s/<token> presenter
 * in a same-origin iframe, auth riding the team cookie. The share surface
 * stays the only content door, so this component never touches content APIs.
 *
 * List state is URL-driven (the /pages pattern): `?q=` search, `?sort=` order,
 * `?page=` pager, `?s=<token>` selection — so everything is linkable and
 * refresh-safe. On mobile the list and reader stack: list first, reader with a
 * back button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowUpDown, ChevronDown, ExternalLink, Globe, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ListPager } from '@/components/layout/list-pager';
import { formatDate } from '@/lib/format-datetime';
import { cn } from '@/lib/utils';

type Item = {
  token: string;
  nodeId: string;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
  mode: 'team' | 'public';
};

type SectionResponse = {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
};

type Sort = 'newest' | 'oldest' | 'updated' | 'title';

const SORT_LABELS: Record<Sort, string> = {
  newest: 'Newest shared',
  oldest: 'Oldest shared',
  updated: 'Recently updated',
  title: 'Title A–Z',
};

const SORTS = Object.keys(SORT_LABELS) as Sort[];

export function TeamSection({
  type,
  emptyHint,
}: {
  type: string;
  /** Section-specific empty-state hint, e.g. "Nothing shared yet." */
  emptyHint?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedToken = searchParams.get('s');
  const query = searchParams.get('q')?.trim() ?? '';
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const sortParam = searchParams.get('sort');
  const sort: Sort = SORTS.includes(sortParam as Sort) ? (sortParam as Sort) : 'newest';

  const [data, setData] = useState<SectionResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [searchInput, setSearchInput] = useState(query);

  // Merge a patch into the query string (null/'' deletes a key) and replace —
  // keeps selection/pager out of history like the rest of the workspace.
  const go = useCallback(
    (patch: Record<string, string | number | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') params.delete(k);
        else params.set(k, String(v));
      }
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const qs = new URLSearchParams({ type });
      if (query) qs.set('q', query);
      if (sort !== 'newest') qs.set('sort', sort);
      if (page > 1) qs.set('page', String(page));
      const r = await fetch(`/api/team/list?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as SectionResponse);
    } catch {
      setFailed(true);
    }
  }, [type, query, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced search: push `q` when the INPUT changes (resetting to page 1 and
  // dropping any selection a new result set may not contain). When ?q= moves
  // without an input edit (back/forward, external link), adopt it into the box
  // instead of re-pushing stale text — lastInputRef tells the two cases apart.
  const lastInputRef = useRef(searchInput);
  useEffect(() => {
    if (searchInput === lastInputRef.current) {
      if (query !== searchInput.trim()) {
        lastInputRef.current = query;
        setSearchInput(query);
      }
      return;
    }
    lastInputRef.current = searchInput;
    if (searchInput.trim() === query) return;
    const t = setTimeout(() => go({ q: searchInput.trim() || null, page: null, s: null }), 300);
    return () => clearTimeout(t);
  }, [searchInput, query, go]);

  const select = (token: string | null) => go({ s: token });

  const items = data?.items ?? null;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 30;
  const selected = items?.find((i) => i.token === selectedToken) ?? null;

  if (items === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {failed ? 'Could not load this section.' : 'Loading…'}
        </p>
      </div>
    );
  }

  // A genuinely empty section (nothing shared, no active search) keeps the
  // clean centered hint; once a search is active we always show the controls.
  const isEmptySection = total === 0 && !query;
  if (isEmptySection) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-center text-sm text-muted-foreground">
          {emptyHint ?? 'Nothing shared here yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[340px_1fr]">
      {/* List pane — hidden on mobile while reading */}
      <div
        className={cn('flex min-h-0 flex-col border-r border-border', selected && 'hidden md:flex')}
      >
        {/* Search + sort header */}
        <div className="space-y-2 border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search…"
              className="pl-8"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-muted-foreground"
                title="Sort"
              >
                <ArrowUpDown className="size-3.5" />
                {SORT_LABELS[sort]}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(v) => go({ sort: v === 'newest' ? null : v, page: null })}
              >
                {SORTS.map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {SORT_LABELS[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* A later fetch failed (params changed, session hiccup) — the list
            below is the last successful load, say so instead of going silent. */}
        {failed && (
          <p className="border-b border-border bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            Couldn&rsquo;t refresh — showing the last loaded results.
          </p>
        )}

        {/* Scrollable card list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No matches for “{query}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 p-2">
              {items.map((item) => (
                <li key={item.token}>
                  <button
                    type="button"
                    onClick={() => select(item.token)}
                    className={cn(
                      'block w-full rounded-md border border-l-[3px] border-border border-l-border px-3 py-2 text-left transition-colors hover:bg-muted/50',
                      item.token === selectedToken && 'border-l-primary bg-muted/40',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {item.icon ? <span className="mr-1.5">{item.icon}</span> : null}
                        {item.title}
                      </span>
                      {item.mode === 'public' && (
                        <span
                          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                          title="Also shared publicly"
                        >
                          <Globe className="size-3" aria-hidden />
                        </span>
                      )}
                    </div>
                    {item.summary && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {item.summary}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground/70">
                      {formatDate(item.updatedAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* page/total/pageSize all come from the same response snapshot, so the
            pager never mixes a new URL page with a stale total. */}
        <ListPager
          page={data?.page ?? page}
          total={total}
          pageSize={pageSize}
          onGo={(p) => go({ page: p <= 1 ? null : p })}
        />
      </div>

      {/* Reader pane */}
      <div className={cn('flex min-h-0 flex-col', !selected && 'hidden md:flex')}>
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5">
              <Button variant="ghost" size="sm" className="md:hidden" onClick={() => select(null)}>
                <ArrowLeft /> Back
              </Button>
              <p className="min-w-0 flex-1 truncate text-sm font-medium max-md:text-right md:text-center">
                {selected.icon ? <span className="mr-1.5">{selected.icon}</span> : null}
                {selected.title}
              </p>
              <Button variant="ghost" size="sm" asChild aria-label="Open in a new tab">
                <a href={`/s/${selected.token}`} target="_blank" rel="noreferrer">
                  <ExternalLink />
                </a>
              </Button>
            </div>
            <iframe
              key={selected.token}
              src={`/s/${selected.token}`}
              title={selected.title}
              className="min-h-0 w-full flex-1 border-0 bg-background"
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">Select an item to read it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
