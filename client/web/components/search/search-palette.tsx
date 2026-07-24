'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { ApiError, apiFetch } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@mantle/web-ui/ui/command';
import { ALL_NAV_ITEMS } from '@mantle/web-ui/layout/nav-items';
import { nodeTypeIcon } from '@/components/search/node-type-icons';
import {
  displayTitle,
  filterNavItems,
  isSearchableQuery,
  relativeUpdatedAt,
  type SearchChunkResult,
  type SearchNodeResult,
} from '@/components/search/search-palette-helpers';

type Mode = 'nodes' | 'chunks';

const DEBOUNCE_MS = 300;
const LIMIT = 20;

/**
 * Global ⌘K search palette — the web face of `GET /api/search`. One dialog,
 * summoned from the shell (keyboard or the header magnifier): a static "Go to"
 * nav group plus server-ranked results. Results stay in the engine's relevance
 * order (`shouldFilter={false}` — regrouping or re-filtering client-side would
 * silently undo the ranking). Selecting a row routes through `/n/<id>`, the
 * resolver that already knows every node type's surface.
 *
 * Fetches are debounced and sequence-guarded (the mention-list idiom): only the
 * newest request may apply, so a slow early query can never paint over a fast
 * later one. Old rows stay rendered while the next fetch is in flight.
 */
export function SearchPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('nodes');
  const [nodeResults, setNodeResults] = useState<SearchNodeResult[]>([]);
  const [chunkResults, setChunkResults] = useState<SearchChunkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once the current query+mode has a response — distinguishes "no
  // results" from "still waiting" without clearing the previous rows.
  const [settled, setSettled] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    setSettled(false);
    setError(null);
    if (!isSearchableQuery(q)) {
      seqRef.current++; // invalidate any in-flight fetch
      setNodeResults([]);
      setChunkResults([]);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ q, limit: String(LIMIT) });
      if (mode === 'chunks') params.set('mode', 'chunks');
      apiFetch<{ results: (SearchNodeResult | SearchChunkResult)[] }>(
        `/api/search?${params.toString()}`,
        { signal: ctrl.signal },
      )
        .then((data) => {
          if (seq !== seqRef.current) return; // a newer query superseded this one
          if (mode === 'chunks') setChunkResults((data.results as SearchChunkResult[]) ?? []);
          else setNodeResults((data.results as SearchNodeResult[]) ?? []);
          setLoading(false);
          setSettled(true);
        })
        .catch((err) => {
          if (seq !== seqRef.current || ctrl.signal.aborted) return;
          setLoading(false);
          setSettled(true);
          setError(err instanceof ApiError ? err.message : 'Search failed');
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, mode, open]);

  const go = (path: string) => {
    onOpenChange(false);
    router.push(path);
  };

  const navMatches = filterNavItems(ALL_NAV_ITEMS, query);
  const results = mode === 'chunks' ? chunkResults : nodeResults;
  const searchable = isSearchableQuery(query);
  const showEmpty = searchable && settled && !loading && !error && results.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      title="Search"
      description="Search everything in your brain"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search your brain…"
        onKeyDown={(e) => {
          // Tab flips result ↔ passage mode instead of moving focus.
          if (e.key === 'Tab') {
            e.preventDefault();
            setMode((m) => (m === 'nodes' ? 'chunks' : 'nodes'));
          }
        }}
      />
      <CommandList className="max-h-[60vh]">
        {navMatches.length > 0 && (
          <>
            <CommandGroup heading="Go to">
              {navMatches.map((item) => (
                <CommandItem
                  key={`nav:${item.href}`}
                  value={`nav:${item.href}`}
                  onSelect={() => go(item.href)}
                >
                  <item.icon />
                  <span className="truncate">{item.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {item.href}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {!searchable ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search notes, pages, files, mail and more
          </div>
        ) : (
          <CommandGroup heading={mode === 'chunks' ? 'Passages' : 'Results'}>
            {loading && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Searching…
              </div>
            )}
            {error && <div className="px-2 py-1.5 text-xs text-muted-foreground">{error}</div>}
            {showEmpty && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No {mode === 'chunks' ? 'passages' : 'results'} for “{query.trim()}”
              </div>
            )}
            {mode === 'nodes'
              ? nodeResults.map((r) => {
                  const Icon = nodeTypeIcon(r.type);
                  return (
                    <CommandItem
                      key={`node:${r.id}`}
                      value={`node:${r.id}`}
                      onSelect={() => go(`/n/${r.id}`)}
                    >
                      <Icon />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {displayTitle(r.title)}
                        </span>
                        {r.summary && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {r.summary}
                          </span>
                        )}
                      </span>
                      {r.supersededBy && <SupersededBadge succ={r.supersededBy} go={go} />}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {relativeUpdatedAt(r.updatedAt)}
                      </span>
                    </CommandItem>
                  );
                })
              : chunkResults.map((r) => {
                  const Icon = nodeTypeIcon(r.nodeType);
                  return (
                    <CommandItem
                      key={`chunk:${r.nodeId}:${r.ordinal}`}
                      value={`chunk:${r.nodeId}:${r.ordinal}`}
                      onSelect={() => go(`/n/${r.nodeId}`)}
                    >
                      <Icon className="self-start" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-muted-foreground">
                          {displayTitle(r.nodeTitle)}
                          {r.heading ? ` · ${r.heading}` : ''}
                        </span>
                        <span className="line-clamp-2 font-serif text-sm">{r.text}</span>
                      </span>
                      {r.supersededBy && <SupersededBadge succ={r.supersededBy} go={go} />}
                    </CommandItem>
                  );
                })}
          </CommandGroup>
        )}
      </CommandList>

      <div className="flex items-center justify-between border-t px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={mode === 'nodes' ? 'secondary' : 'ghost'}
            className="h-7 px-2 text-xs"
            onClick={() => setMode('nodes')}
          >
            Results
          </Button>
          <Button
            size="sm"
            variant={mode === 'chunks' ? 'secondary' : 'ghost'}
            className="h-7 px-2 text-xs"
            onClick={() => setMode('chunks')}
          >
            Passages
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">Tab to switch · Enter to open</span>
      </div>
    </CommandDialog>
  );
}

/**
 * Destructive-toned hint on rows whose content has a living successor.
 * Clicking it opens the newer copy; clicking the row still opens the original.
 */
function SupersededBadge({
  succ,
  go,
}: {
  succ: { id: string; title: string | null };
  go: (path: string) => void;
}) {
  return (
    <button
      type="button"
      title={succ.title ? `Open newer copy: ${succ.title}` : 'Open newer copy'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        go(`/n/${succ.id}`);
      }}
      className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
    >
      Superseded
    </button>
  );
}
