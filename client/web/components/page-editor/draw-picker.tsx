'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Loader2, PenTool, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@mantle/web-ui/ui/dialog';
import { Input } from '@mantle/web-ui/ui/input';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { assetUrl } from '@mantle/web-ui/asset-url';
import { cn } from '@mantle/web-ui/lib/utils';

/**
 * The human entry point for embedding a drawing in a page (the `/drawing`
 * slash item). A page embeds a drawing as an image node with `drawId`
 * (markdown: `![alt](draw:<id>)`) — the schema and every renderer already
 * handle that; this dialog is just the missing way to CREATE the embed.
 *
 * Editor-only, like the slash menu itself: no schema, no doc writes beyond the
 * insert, so the read-only PageView is untouched. The slash item can't render
 * React of its own (it's a static command), so it dispatches a DOM event on the
 * editor and this component — mounted once by PageEditor — owns the dialog.
 */
export const DRAW_PICKER_EVENT = 'mantle:open-draw-picker';

/** Ask the mounted DrawPicker to open. Safe to call from a static slash item. */
export function openDrawPicker(editor: Editor): void {
  editor.view.dom.dispatchEvent(new CustomEvent(DRAW_PICKER_EVENT, { bubbles: true }));
}

type DrawRow = {
  id: string;
  title: string;
  hasSvg: boolean;
  updatedAt: string;
};

export function DrawPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<DrawRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // Row 0 is "New drawing"; results follow. Keyboard selection over that list.
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Newest fetch wins — same guard as the mention list (a slow early query
  // must not clobber a faster later one).
  const seqRef = useRef(0);

  useEffect(() => {
    const dom = editor.view.dom;
    const onOpen = () => {
      setQuery('');
      setSelected(0);
      setOpen(true);
    };
    dom.addEventListener(DRAW_PICKER_EVENT, onOpen);
    return () => dom.removeEventListener(DRAW_PICKER_EVENT, onOpen);
  }, [editor]);

  // Fetch on open + whenever the query settles. The list route caps at 50 and
  // sorts by last-edited, which is the right default for "pick one to embed".
  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      const q = query.trim();
      apiFetch<{ draws?: DrawRow[] }>(`/api/draws${q ? `?q=${encodeURIComponent(q)}` : ''}`, {
        signal: ctrl.signal,
      })
        .then((data) => {
          if (seq !== seqRef.current) return;
          setRows(data.draws ?? []);
          setLoading(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setRows([]);
          setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, query]);

  useEffect(() => setSelected(0), [rows]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const embed = useCallback(
    (id: string, title: string) => {
      setOpen(false);
      // Same node shape markdownToDoc produces for `![alt](draw:<id>)` — the
      // editor derives the <img> src from drawId, serialization round-trips it.
      editor
        .chain()
        .focus()
        .insertContent({ type: 'image', attrs: { src: null, alt: title, drawId: id } })
        .run();
    },
    [editor],
  );

  const createAndEmbed = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    // Open the tab synchronously so the popup blocker sees a user gesture; the
    // POST fills in the destination once the drawing exists.
    const win = window.open('', '_blank');
    try {
      const { draw } = await apiSend<{ draw: { id: string } }>('/api/draws', 'POST', {
        title: 'Untitled drawing',
      });
      embed(draw.id, 'Untitled drawing');
      if (win) win.location.href = `/draw/${draw.id}`;
    } catch {
      win?.close();
    } finally {
      setCreating(false);
    }
  }, [creating, embed]);

  const choose = useCallback(
    (i: number) => {
      if (i === 0) {
        void createAndEmbed();
        return;
      }
      const row = rows[i - 1];
      if (row) embed(row.id, row.title);
    },
    [rows, createAndEmbed, embed],
  );

  const count = rows.length + 1;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => (s + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => (s - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(selected);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md gap-3 p-4">
        <DialogHeader>
          <DialogTitle>Embed a drawing</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search drawings…"
        />
        <div ref={listRef} className="max-h-72 overflow-y-auto scrollbar-thin -mx-1 px-1">
          <PickerRow
            index={0}
            selected={selected === 0}
            onHover={setSelected}
            onChoose={choose}
            icon={
              creating ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-4" aria-hidden />
              )
            }
            title="New drawing"
            subtitle="Create, embed here, and open the canvas"
          />
          {rows.map((row, i) => (
            <PickerRow
              key={row.id}
              index={i + 1}
              selected={selected === i + 1}
              onHover={setSelected}
              onChoose={choose}
              icon={
                row.hasSvg ? (
                  // The committed snapshot as a thumbnail — assetUrl carries the
                  // `?at=` token a detached client's <img> needs.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetUrl(`/api/draws/${encodeURIComponent(row.id)}/svg?raw=1`)}
                    alt=""
                    className="size-full rounded-[inherit] bg-white object-contain"
                  />
                ) : (
                  <PenTool className="size-4" aria-hidden />
                )
              }
              title={row.title}
              subtitle={`Edited ${new Date(row.updatedAt).toLocaleDateString()}`}
            />
          ))}
          {rows.length === 0 && (
            <div className="flex items-center gap-2 px-2.5 py-3 text-sm text-muted-foreground">
              {loading && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
              {loading ? 'Searching…' : query.trim() ? 'No matching drawings' : 'No drawings yet'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PickerRow({
  index,
  selected,
  onHover,
  onChoose,
  icon,
  title,
  subtitle,
}: {
  index: number;
  selected: boolean;
  onHover: (i: number) => void;
  onChoose: (i: number) => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      data-index={index}
      onMouseEnter={() => onHover(index)}
      onClick={() => onChoose(index)}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      {/* Selected-row children derive from accent-foreground — see the same
          note in slash-menu.tsx. */}
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border',
          selected
            ? 'border-accent-foreground/25 bg-accent-foreground/10'
            : 'border-border bg-background',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium leading-tight">{title}</span>
        <span
          className={cn(
            'block truncate text-xs',
            selected ? 'text-accent-foreground' : 'text-muted-foreground',
          )}
        >
          {subtitle}
        </span>
      </span>
    </button>
  );
}
