'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AtSign } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MentionItem = { id: string; label: string; kind: string };

export type MentionListHandle = { onKeyDown: (p: { event: KeyboardEvent }) => boolean };

export type MentionListProps = {
  items: MentionItem[];
  command: (item: MentionItem) => void;
};

export const MentionList = forwardRef<MentionListHandle, MentionListProps>(function MentionList(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelected(0), [items]);

  useLayoutEffect(() => {
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (i: number) => {
    const item = items[i];
    if (item) command(item);
  };

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
    [items, selected],
  );

  if (items.length === 0) {
    return (
      <div className="w-64 rounded-xl border border-border bg-popover p-3 text-sm text-muted-foreground shadow-lg">
        No matching people or things
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="max-h-72 w-64 overflow-y-auto scrollbar-thin rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      {items.map((item, i) => (
        <button
          key={item.id}
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
            <AtSign className="size-3.5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{item.label}</span>
            <span className="block truncate text-xs text-muted-foreground">{item.kind}</span>
          </span>
        </button>
      ))}
    </div>
  );
});
