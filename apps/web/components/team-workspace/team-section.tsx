'use client';

/**
 * One /team workspace section: the list of team-visible shares of one type
 * (left, mirroring the owner screens' master-detail list pane) and a
 * read-only reader for the selected item (right) — the /s/<token> presenter
 * in a same-origin iframe, auth riding the team cookie. The share surface
 * stays the only content door, so this component never touches content APIs.
 *
 * List state is URL-driven (the /pages pattern): `?q=` search, `?tag=`
 * filter, `?sort=` order, `?page=` pager, `?s=<token>` selection — so
 * everything is linkable and refresh-safe. On mobile the list and reader
 * stack: list first, reader with a back button.
 *
 * The PAGES section (`tree` prop) mirrors the owner /pages pane exactly:
 * a collapsible sub-page TREE over the shared subset (an unshared parent
 * leaves its children as roots — buildChildrenIndex's orphan rule), compact
 * rows instead of cards, and the same search/sort/tag controls — minus every
 * owner action (no New, no drag, no delete). Search or a tag filter drops to
 * flat list mode, same as the owner screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Search,
  Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ListPager } from '@/components/layout/list-pager';
import { buildChildrenIndex } from '@/app/(app)/pages/page-tree';
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
  parentId: string | null;
  tags: string[];
};

type TagCount = { tag: string; count: number };

type SectionResponse = {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  tags?: TagCount[];
  truncated?: boolean;
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
  tree = false,
}: {
  type: string;
  /** Section-specific empty-state hint, e.g. "Nothing shared yet." */
  emptyHint?: string;
  /** Pages: collapsible sub-page tree when no search/tag filter is active. */
  tree?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedToken = searchParams.get('s');
  const query = searchParams.get('q')?.trim() ?? '';
  const activeTag = searchParams.get('tag')?.trim() || null;
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const sortParam = searchParams.get('sort');
  const sort: Sort = SORTS.includes(sortParam as Sort) ? (sortParam as Sort) : 'newest';

  // Tree view only without filters — search/tag results are flat (owner rule).
  const treeActive = tree && !query && !activeTag;

  const [data, setData] = useState<SectionResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [searchInput, setSearchInput] = useState(query);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      if (activeTag) qs.set('tag', activeTag);
      if (sort !== 'newest') qs.set('sort', sort);
      if (treeActive) qs.set('tree', '1');
      else if (page > 1) qs.set('page', String(page));
      const r = await fetch(`/api/team/list?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as SectionResponse);
    } catch {
      setFailed(true);
    }
  }, [type, query, activeTag, sort, page, treeActive]);

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
  const tags = data?.tags ?? [];
  const selected = items?.find((i) => i.token === selectedToken) ?? null;

  // Tree index over the loaded (shared) pages; sibling order = server sort.
  const treeItems = useMemo(() => (items ?? []).map((i) => ({ ...i, id: i.nodeId })), [items]);
  const childrenByParent = useMemo(() => buildChildrenIndex(treeItems), [treeItems]);
  const hasChildren = useCallback(
    (id: string) => (childrenByParent.get(id) ?? []).length > 0,
    [childrenByParent],
  );
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (items === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {failed ? 'Could not load this section.' : 'Loading…'}
        </p>
      </div>
    );
  }

  // A genuinely empty section (nothing shared, no active search/filter) keeps
  // the clean centered hint; once a filter is active we always show controls.
  const isEmptySection = total === 0 && !query && !activeTag;
  if (isEmptySection) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-center text-sm text-muted-foreground">
          {emptyHint ?? 'Nothing shared here yet.'}
        </p>
      </div>
    );
  }

  // Compact row (the owner /pages look): icon + title + public badge, chevron
  // when it has sub-pages. Used for tree AND flat modes of a tree section.
  const compactRow = (item: (typeof treeItems)[number], depth: number) => {
    const kids = treeActive && hasChildren(item.id);
    const isExpanded = expanded.has(item.id);
    return (
      <li key={item.token}>
        <div
          className={cn(
            'group flex items-center rounded-md border-l-[3px] border-l-transparent pr-2 transition-colors hover:bg-muted/50',
            item.token === selectedToken && 'border-l-primary bg-muted/40',
          )}
          style={{ paddingLeft: depth * 16 }}
        >
          {kids ? (
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn('size-3.5 transition-transform', isExpanded && 'rotate-90')}
              />
            </button>
          ) : (
            <span className="size-6 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={() => select(item.token)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          >
            <span className="min-w-0 truncate text-sm">
              {item.icon ? <span className="mr-1.5">{item.icon}</span> : null}
              {item.title}
            </span>
            {item.mode === 'public' && (
              <Globe
                className="size-3 shrink-0 text-muted-foreground"
                aria-label="Also shared publicly"
              />
            )}
          </button>
        </div>
      </li>
    );
  };

  // Flatten the tree into rows honoring expand/collapse (owner renderTree).
  const renderTree = (parentId: string | null, depth: number): ReactNode[] => {
    const kids = childrenByParent.get(parentId) ?? [];
    const rows: ReactNode[] = [];
    for (const p of kids) {
      rows.push(compactRow(p, depth));
      if (hasChildren(p.id) && expanded.has(p.id)) rows.push(...renderTree(p.id, depth + 1));
    }
    return rows;
  };

  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[340px_1fr]">
      {/* List pane — hidden on mobile while reading */}
      <div
        className={cn('flex min-h-0 flex-col border-r border-border', selected && 'hidden md:flex')}
      >
        {/* Search + sort + tag header */}
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
          <div className="flex items-center gap-1">
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
            {tags.length > 0 && (
              <TagFilter
                tags={tags}
                activeTag={activeTag}
                onSelect={(t) => go({ tag: t, page: null, s: null })}
              />
            )}
          </div>
        </div>

        {/* A later fetch failed (params changed, session hiccup) — the list
            below is the last successful load, say so instead of going silent. */}
        {failed && (
          <p className="border-b border-border bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            Couldn&rsquo;t refresh — showing the last loaded results.
          </p>
        )}
        {data?.truncated && (
          <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            Showing the first {items.length} shared pages — search to find the rest.
          </p>
        )}

        {/* Scrollable list — tree rows for pages, cards for the other types */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {query ? <>No matches for “{query}”.</> : <>Nothing tagged “{activeTag}”.</>}
            </p>
          ) : tree ? (
            <ul className="flex flex-col gap-0.5 p-2">
              {treeActive ? renderTree(null, 0) : treeItems.map((i) => compactRow(i, 0))}
            </ul>
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

        {/* Tree mode is unpaged (the whole hierarchy is loaded); page/total/
            pageSize otherwise come from the same response snapshot, so the
            pager never mixes a new URL page with a stale total. */}
        {!treeActive && (
          <ListPager
            page={data?.page ?? page}
            total={total}
            pageSize={pageSize}
            onGo={(p) => go({ page: p <= 1 ? null : p })}
          />
        )}
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

/** The owner /pages tag filter, member-sized: a popover command list of the
 *  section's tags with counts; picking the active tag again clears it. */
function TagFilter({
  tags,
  activeTag,
  onSelect,
}: {
  tags: TagCount[];
  activeTag: string | null;
  onSelect: (tag: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (tag: string | null) => {
    onSelect(tag);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className={cn('h-7 gap-1 px-2 text-muted-foreground', activeTag && 'text-foreground')}
          title="Filter by tag"
        >
          <Tag className="size-3.5" />
          <span className="max-w-32 truncate">{activeTag ?? 'All tags'}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Search tags…" className="border-0 focus:ring-0" />
          <CommandList className="max-h-72 scrollbar-thin">
            <CommandEmpty className="px-3 py-6 text-center text-xs text-muted-foreground">
              No tags found.
            </CommandEmpty>
            <CommandGroup>
              {/* Sentinel value so a tag search doesn't accidentally match it. */}
              <CommandItem value="__all_items__" onSelect={() => choose(null)}>
                <Check className={cn('size-4', activeTag === null ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1">All items</span>
              </CommandItem>
              {tags.map((t) => (
                <CommandItem
                  key={t.tag}
                  value={t.tag}
                  onSelect={() => choose(activeTag === t.tag ? null : t.tag)}
                >
                  <Check
                    className={cn('size-4', activeTag === t.tag ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">{t.tag}</span>
                  <span className="text-xs text-muted-foreground">{t.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
