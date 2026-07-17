'use client';

/**
 * One /team workspace section: the card list of team-visible shares of one
 * type (left, mirroring the owner screens' master-detail list pane) and a
 * read-only reader for the selected item (right) — the /s/<token> presenter
 * in a same-origin iframe, auth riding the team cookie. The share surface
 * stays the only content door, so this component never touches content APIs.
 *
 * Selection is URL-driven (?s=<token>) so items are linkable and refresh-safe.
 * On mobile the list and reader stack: list first, reader with a back button.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await fetch(`/api/team/list?type=${encodeURIComponent(type)}`, {
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { items: Item[] };
      setItems(d.items);
    } catch {
      setFailed(true);
    }
  }, [type]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = (token: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (token) params.set('s', token);
    else params.delete('s');
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const selected = items?.find((i) => i.token === selectedToken) ?? null;

  if (items === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">{failed ? 'Could not load this section.' : 'Loading…'}</p>
      </div>
    );
  }

  if (items.length === 0) {
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
        className={cn(
          'min-h-0 overflow-y-auto border-r border-border',
          selected && 'hidden md:block',
        )}
      >
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
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground/70">{formatDate(item.updatedAt)}</p>
              </button>
            </li>
          ))}
        </ul>
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
