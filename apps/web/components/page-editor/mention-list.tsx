'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AtSign, FileText, Loader2 } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { apiFetch } from '@mantle/web-ui/api-fetch';

export type MentionItem = {
  ref: 'node' | 'entity';
  id: string;
  label: string;
  kind: string;
};

export type MentionListHandle = { onKeyDown: (p: { event: KeyboardEvent }) => boolean };

// Props come straight from TipTap's suggestion plugin. We read `query` (the text
// after `@`) and fetch results IN THIS COMPONENT rather than from the
// suggestion's `items()` option — the plugin shares one `props` object across
// its async `update()` calls, so awaiting a fetch there races under fast typing
// and a stale-empty result can land last. Fetching here, keyed on `query` with a
// sequence guard, makes the latest query always win.
export type MentionListProps = {
  query: string;
  command: (item: MentionItem) => void;
};

const GROUP_LABEL: Record<MentionItem['ref'], string> = {
  node: 'Pages & notes',
  entity: 'People & things',
};

export const MentionList = forwardRef<MentionListHandle, MentionListProps>(function MentionList(
  { query, command },
  ref,
) {
  const [items, setItems] = useState<MentionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Monotonic request id — only the newest fetch may apply its result, so a slow
  // earlier query can't clobber a faster later one.
  const seqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setItems([]);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    apiFetch<{ items?: MentionItem[] }>(`/api/mentions/search?q=${encodeURIComponent(q)}`, {
      signal: ctrl.signal,
    })
      .then((data) => {
        if (seq !== seqRef.current) return; // a newer query superseded this one
        setItems(data.items ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setItems([]);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [query]);

  useEffect(() => setSelected(0), [items]);

  useLayoutEffect(() => {
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = useCallback(
    (i: number) => {
      const item = items[i];
      if (item) command(item);
    },
    [items, command],
  );

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected((s) => (s - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          choose(selected);
          return true;
        }
        return false;
      },
    }),
    [items, selected, choose],
  );

  if (items.length === 0) {
    const msg = !query.trim()
      ? 'Type to search pages, notes, or people'
      : loading
        ? 'Searching…'
        : 'No matching pages, notes, or people';
    return (
      <div className="flex w-64 items-center gap-2 rounded-xl border border-border bg-popover p-3 text-sm text-muted-foreground shadow-lg">
        {loading && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
        {msg}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="max-h-72 w-64 overflow-y-auto scrollbar-thin rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      {items.map((item, i) => {
        const showGroup = i === 0 || items[i - 1]?.ref !== item.ref;
        const Icon = item.ref === 'node' ? FileText : AtSign;
        return (
          <div key={`${item.ref}:${item.id}`}>
            {showGroup && (
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {GROUP_LABEL[item.ref]}
              </div>
            )}
            <button
              type="button"
              data-index={i}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(i)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                i === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs capitalize text-muted-foreground">
                  {item.kind}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
});
