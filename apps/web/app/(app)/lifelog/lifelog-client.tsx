'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NotebookPen, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { MOODS, CATEGORIES, moodDisplay, categoryLabel } from '@mantle/content/lifelog-options';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { useToast } from '@/components/ui/toast';
import { TagPill } from '@/components/tag-pill';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';
import { syncSelectionParam } from '@/lib/url-sync';
import { LifelogEditor, type LifelogRow } from './lifelog-editor';

const ALL = '__all__';

export function LifelogClient({
  entries,
  total,
  page,
  pageSize,
  tags,
  activeMood,
  activeCategory,
  activeTag,
  query,
  initialSelectedId,
  initialSelected,
  initialEditing,
}: {
  entries: LifelogRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: { tag: string; count: number }[];
  activeMood: string | null;
  activeCategory: string | null;
  activeTag: string | null;
  query: string;
  initialSelectedId?: string | null;
  initialSelected?: LifelogRow | null;
  initialEditing?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const { pending, go } = useListNav();

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [editing, setEditing] = useState<boolean>(!!initialEditing);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LifelogRow | null>(null);
  const [discard, setDiscard] = useState<{ run: () => void } | null>(null);
  const [searchInput, setSearchInput] = useState(query);

  const selected = useMemo<LifelogRow | null>(() => {
    if (selectedId) {
      return (
        entries.find((n) => n.id === selectedId) ??
        (initialSelected?.id === selectedId ? initialSelected : null)
      );
    }
    return entries[0] ?? null;
  }, [selectedId, entries, initialSelected]);

  const guard = useCallback(
    (run: () => void) => {
      if (editing && dirty) setDiscard({ run });
      else run();
    },
    [editing, dirty],
  );

  const exitEdit = useCallback(() => {
    setEditing(false);
    setCreating(false);
    setDirty(false);
  }, []);

  const selectEntry = (id: string) =>
    guard(() => {
      setSelectedId(id);
      syncSelectionParam('selected', id);
      exitEdit();
    });

  const startCreate = () =>
    guard(() => {
      setCreating(true);
      setEditing(true);
    });

  const startEdit = () => {
    setCreating(false);
    setEditing(true);
  };

  const onSaved = (saved: LifelogRow) => {
    exitEdit();
    setSelectedId(saved.id);
    syncSelectionParam('selected', saved.id);
    router.refresh();
  };

  // Debounced search → URL.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput.trim() === query) return;
      go({ q: searchInput.trim() || null, page: null });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/lifelog/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete life log');
      return;
    }
    toast.success('Life log deleted');
    if (selected?.id === deleteTarget.id) exitEdit();
    if (selectedId === deleteTarget.id) {
      setSelectedId(null);
      syncSelectionParam('selected', null);
    }
    setDeleteTarget(null);
    router.refresh();
  };

  return (
    <div className="relative md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: list ─────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search life logs…"
                className="pl-8"
              />
            </div>
            <Button onClick={startCreate}>
              <Plus /> New
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Select
              value={activeMood ?? ALL}
              onValueChange={(v) => go({ mood: v === ALL ? null : v, page: null })}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Any mood" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any mood</SelectItem>
                {MOODS.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.emoji} {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={activeCategory ?? ALL}
              onValueChange={(v) => go({ category: v === ALL ? null : v, page: null })}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Any area" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any area</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant={activeTag ? 'outline' : 'default'}
                className="h-7 rounded-full px-3"
                onClick={() => go({ tag: null, page: null })}
              >
                All
              </Button>
              {tags.slice(0, 12).map((t) => (
                <Button
                  key={t.tag}
                  size="sm"
                  variant={activeTag === t.tag ? 'default' : 'outline'}
                  className="h-7 rounded-full px-3"
                  onClick={() => go({ tag: activeTag === t.tag ? null : t.tag, page: null })}
                >
                  {t.tag}
                  <span className="ml-1 opacity-60">{t.count}</span>
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* Cards */}
        <div
          className={cn(
            'space-y-2 p-3 transition-opacity md:flex-1 md:overflow-y-auto md:scrollbar-thin',
            pending && 'opacity-60',
          )}
        >
          {entries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
              {query || activeMood || activeCategory || activeTag
                ? 'No life logs match your search or filters.'
                : 'No life logs yet. Click “New” to record who you are, or let your assistant log a thought.'}
            </div>
          ) : (
            entries.map((n) => {
              const md = moodDisplay(n.mood);
              const cat = categoryLabel(n.category);
              return (
                <button
                  key={n.id}
                  onClick={() => selectEntry(n.id)}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-muted/50',
                    selected?.id === n.id && !creating && 'border-l-primary',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 w-4 shrink-0 text-center text-sm" aria-hidden>
                      {md?.emoji || <NotebookPen className="size-4 text-muted-foreground" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{n.title}</div>
                      {(n.summary || n.body) && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {n.summary ?? n.body}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {cat && (
                          <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                            {cat}
                          </span>
                        )}
                        {n.tags.map((t) => (
                          <TagPill key={t} tag={t} />
                        ))}
                      </div>
                    </div>
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
          pending={pending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* ── Right: preview / editor ─────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-hidden">
        {editing ? (
          <LifelogEditor
            entry={creating ? null : selected}
            onSaved={onSaved}
            onCancel={() => guard(exitEdit)}
            onDirtyChange={setDirty}
          />
        ) : selected ? (
          <LifelogPreview
            entry={selected}
            onEdit={startEdit}
            onDelete={() => setDeleteTarget(selected)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a life log, or click <span className="mx-1 font-medium text-foreground">New</span> to start one.
          </div>
        )}
      </div>

      {/* Discard-unsaved-changes guard */}
      <AlertDialog open={discard !== null} onOpenChange={(o) => !o && setDiscard(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This life log has edits that haven’t been saved. Leaving now will lose them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const run = discard?.run;
                setDirty(false);
                setDiscard(null);
                run?.();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>This can’t be undone.</AlertDialogDescription>
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

/** Right-pane read view. */
function LifelogPreview({
  entry,
  onEdit,
  onDelete,
}: {
  entry: LifelogRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const md = moodDisplay(entry.mood);
  const cat = categoryLabel(entry.category);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-background/80 px-6 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{entry.title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {md && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {md.emoji} {md.label}
              </span>
            )}
            {cat && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {cat}
              </span>
            )}
            {entry.tags.map((t) => (
              <TagPill key={t} tag={t} />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete life log"
          >
            <Trash2 />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scrollbar-thin px-6 py-5">
        {entry.body ? (
          <p className="whitespace-pre-wrap text-base leading-relaxed">{entry.body}</p>
        ) : (
          <p className="text-sm italic text-muted-foreground">No content.</p>
        )}

        {entry.summary && (
          <aside className="rounded-md border border-border bg-muted/40 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3.5" aria-hidden /> Indexed summary
            </div>
            <p className="text-sm text-muted-foreground">{entry.summary}</p>
          </aside>
        )}

        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          {entry.entryDate ? <>For {formatDateTime(entry.entryDate)} · </> : null}
          Updated {formatDateTime(entry.updatedAt)} · created {formatDateTime(entry.createdAt)}
        </div>
      </div>
    </div>
  );
}
