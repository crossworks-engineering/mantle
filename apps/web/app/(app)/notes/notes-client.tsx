'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { Input } from '@/components/ui/input';
import { ShareControl } from '@/components/share/share-control';
import { ExportButton } from '@/components/export/export-button';
import { useToast } from '@/components/ui/toast';
import { TagPill } from '@/components/tag-pill';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';
import { syncSelectionParam } from '@/lib/url-sync';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { NoteEditor, type NoteRow } from './note-editor';

type TagCount = { tag: string; count: number };

type NotesListResponse = {
  notes: NoteRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: TagCount[];
};

/** Mirror of @mantle/content's isDigestTag — local copy because that module
 *  pulls in the server-only db client and can't enter the client bundle. */
const isDigestTag = (t: string) =>
  t === 'conversation-digest' || t.startsWith('agent:') || t.startsWith('topic:');

// Draggable list-pane width (md+). Persisted so it sticks across visits.
const WIDTH_KEY = 'mantle:notes-list-width';
const LIST_MIN = 300;
const LIST_MAX = 760;
const LIST_DEFAULT = 380;

export function NotesClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [navPending, startNav] = useTransition();

  // URL is the source of truth (matches the old SSR page); the list query keys
  // off these so a `go()` navigation re-fetches automatically.
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const activeTag = searchParams.get('tag')?.trim() || null;
  const showDigests = searchParams.get('digests') === '1' || (!!activeTag && isDigestTag(activeTag));

  const listQuery = useQuery({
    queryKey: ['notes', { q: query, tag: activeTag, digests: showDigests, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (activeTag) qs.set('tag', activeTag);
      if (showDigests) qs.set('digests', '1');
      if (page > 1) qs.set('page', String(page));
      const s = qs.toString();
      return apiFetch<NotesListResponse>(`/api/notes${s ? `?${s}` : ''}`);
    },
    placeholderData: (prev) => prev,
  });

  const notes = listQuery.data?.notes ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.pageSize ?? 50;
  const tags = listQuery.data?.tags ?? [];

  // Selection + edit mode seed from the URL (a `/notes/[id]` deep-link redirects
  // to `?selected=&edit=1`), then live as local state.
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get('selected')?.trim() || null,
  );
  const [editing, setEditing] = useState<boolean>(searchParams.get('edit') === '1');

  // A deep-linked note may sit outside the current list slice — fetch it so the
  // right pane can open it even when it's not in `notes`.
  const selectedNoteQuery = useQuery({
    queryKey: ['notes', selectedId],
    queryFn: () =>
      apiFetch<{ note: NoteRow }>(`/api/notes/${selectedId}`).then((r) => r.note),
    enabled: !!selectedId && !notes.some((n) => n.id === selectedId),
  });
  const [creating, setCreating] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  /** Pending action held back by the unsaved-changes guard. */
  const [discard, setDiscard] = useState<{ run: () => void } | null>(null);

  const [searchInput, setSearchInput] = useState(query);

  // Tag filter row collapses to one line; a toggle reveals the rest.
  const tagRowRef = useRef<HTMLDivElement>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [tagsOverflow, setTagsOverflow] = useState(false);

  useEffect(() => {
    if (tagsExpanded) return;
    const el = tagRowRef.current;
    if (!el) return;
    const check = () => setTagsOverflow(el.scrollHeight - el.clientHeight > 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags, tagsExpanded]);

  // ── Resizable list pane ──────────────────────────────────────────────
  const gridRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(LIST_DEFAULT);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(v) && v >= LIST_MIN && v <= LIST_MAX) setListWidth(v);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(listWidth)));
    } catch {
      /* ignore */
    }
  }, [listWidth]);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const left = gridRef.current?.getBoundingClientRect().left ?? 0;
      setListWidth(Math.min(LIST_MAX, Math.max(LIST_MIN, ev.clientX - left)));
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ── Selection / edit state machine ──────────────────────────────────
  const selected = useMemo<NoteRow | null>(() => {
    if (selectedId) {
      return (
        notes.find((n) => n.id === selectedId) ??
        (selectedNoteQuery.data?.id === selectedId ? selectedNoteQuery.data : null)
      );
    }
    return notes[0] ?? null;
  }, [selectedId, notes, selectedNoteQuery.data]);

  /** Run an action, but if the editor has unsaved changes, confirm first. */
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
    setFocus(false);
    setDirty(false);
  }, []);

  const selectNote = (id: string) =>
    guard(() => {
      setSelectedId(id);
      syncSelectionParam('selected', id);
      exitEdit();
    });

  const startCreate = () =>
    guard(() => {
      setCreating(true);
      setEditing(true);
      setFocus(false);
    });

  const startEdit = () => {
    setCreating(false);
    setEditing(true);
  };

  const onSaved = (saved: NoteRow) => {
    setEditing(false);
    setCreating(false);
    setFocus(false);
    setDirty(false);
    setSelectedId(saved.id);
    syncSelectionParam('selected', saved.id);
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const buildHref = (over: {
    page?: number;
    tag?: string | null;
    q?: string | null;
    digests?: boolean;
  }) => {
    const nextTag = over.tag !== undefined ? over.tag : activeTag;
    const nextQ = over.q !== undefined ? over.q : query || null;
    const nextPage = over.page !== undefined ? over.page : page;
    const nextDigests = over.digests !== undefined ? over.digests : showDigests;
    const params = new URLSearchParams();
    if (nextTag) params.set('tag', nextTag);
    if (nextQ) params.set('q', nextQ);
    if (nextDigests) params.set('digests', '1');
    if (nextPage && nextPage > 1) params.set('page', String(nextPage));
    const s = params.toString();
    return s ? `${pathname}?${s}` : pathname;
  };
  const go = (over: Parameters<typeof buildHref>[0]) => startNav(() => router.push(buildHref(over)));

  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput.trim() === query) return;
      go({ q: searchInput.trim() || null, page: 1 });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/notes/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete note');
      return;
    }
    toast.success('Note deleted');
    if (selected?.id === deleteTarget.id) exitEdit();
    if (selectedId === deleteTarget.id) {
      setSelectedId(null);
      syncSelectionParam('selected', null);
    }
    setDeleteTarget(null);
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
  };

  if (listQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (listQuery.isError && !listQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load notes.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="relative md:grid md:h-full md:overflow-hidden"
      style={{
        gridTemplateColumns: focus ? '0px minmax(0, 1fr)' : `${listWidth}px minmax(0, 1fr)`,
      }}
    >
      {/* ── Left: list ─────────────────────────────────────────────── */}
      <div
        className={cn(
          'flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r',
          focus && 'hidden',
        )}
      >
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search notes…"
                className="pl-8"
              />
            </div>
            <Button onClick={startCreate}>
              <Plus /> New
            </Button>
          </div>

          <div className="flex items-start gap-1.5">
            <div
              ref={tagRowRef}
              className={cn(
                'flex flex-1 flex-wrap items-center gap-1.5',
                !tagsExpanded && 'max-h-7 overflow-hidden',
              )}
            >
              {tags.length > 0 && (
                <Button
                  size="sm"
                  variant={activeTag ? 'outline' : 'default'}
                  className="h-7 rounded-full px-3"
                  onClick={() => go({ tag: null, page: 1 })}
                >
                  All
                </Button>
              )}
              {tags.map((t) => (
                <Button
                  key={t.tag}
                  size="sm"
                  variant={activeTag === t.tag ? 'default' : 'outline'}
                  className="h-7 rounded-full px-3"
                  onClick={() => go({ tag: activeTag === t.tag ? null : t.tag, page: 1 })}
                >
                  {t.tag}
                  <span className="ml-1 opacity-60">{t.count}</span>
                </Button>
              ))}
            </div>
            {tagsOverflow && (
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                onClick={() => setTagsExpanded((v) => !v)}
                aria-label={tagsExpanded ? 'Show fewer tags' : 'Show all tags'}
                title={tagsExpanded ? 'Show fewer tags' : 'Show all tags'}
              >
                <ChevronDown className={cn('transition-transform', tagsExpanded && 'rotate-180')} />
              </Button>
            )}
            <Button
              size="sm"
              variant={showDigests ? 'default' : 'outline'}
              className={cn('h-7 shrink-0 rounded-full px-3', !showDigests && 'text-muted-foreground')}
              onClick={() =>
                go({
                  digests: !showDigests,
                  page: 1,
                  // Hiding digests while filtered on a digest tag would show an
                  // empty list — drop the tag along with them.
                  ...(showDigests && activeTag && isDigestTag(activeTag) ? { tag: null } : {}),
                })
              }
              title={showDigests ? 'Hide agent conversation digests' : 'Show agent conversation digests'}
            >
              <Sparkles /> Digests
            </Button>
          </div>
        </div>

        {/* Cards */}
        <div
          className={cn(
            'space-y-2 p-3 transition-opacity md:flex-1 md:overflow-y-auto md:scrollbar-thin',
            navPending && 'opacity-60',
          )}
        >
          {notes.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
              {query || activeTag
                ? 'No notes match your search or filter.'
                : 'No notes yet. Click “New” or ask your assistant to add one.'}
            </div>
          ) : (
            notes.map((n) => (
              <button
                key={n.id}
                onClick={() => selectNote(n.id)}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-muted/50',
                  selected?.id === n.id && !creating && 'border-l-primary',
                )}
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{n.title}</div>
                    {(n.summary || n.content) && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {n.summary ?? n.content.slice(0, 200)}
                      </p>
                    )}
                    {n.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {n.tags.map((t) => (
                          <TagPill key={t} tag={t} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Pagination */}
        {total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {total} {total === 1 ? 'note' : 'notes'}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="tabular-nums">
                {page} / {totalPages}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="size-7"
                disabled={page <= 1 || navPending}
                onClick={() => go({ page: page - 1 })}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="size-7"
                disabled={page >= totalPages || navPending}
                onClick={() => go({ page: page + 1 })}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle */}
      {!focus && (
        <div
          onPointerDown={startResize}
          className="absolute inset-y-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/20 md:block"
          style={{ left: `${listWidth}px` }}
          aria-hidden
        />
      )}

      {/* ── Right: preview / editor ─────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-hidden">
        {editing ? (
          <NoteEditor
            note={creating ? null : selected}
            focus={focus}
            onToggleFocus={() => setFocus((f) => !f)}
            onSaved={onSaved}
            onCancel={() => guard(exitEdit)}
            onDirtyChange={setDirty}
          />
        ) : selected ? (
          <NotePreview note={selected} onEdit={startEdit} onDelete={() => setDeleteTarget(selected)} />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a note, or click <span className="mx-1 font-medium text-foreground">New</span> to start one.
          </div>
        )}
      </div>

      {/* Discard-unsaved-changes guard */}
      <AlertDialog open={discard !== null} onOpenChange={(o) => !o && setDiscard(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This note has edits that haven’t been saved. Leaving now will lose them.
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

/** Right-pane read view — de-boxed: full-width prose, sticky header, own scroll. */
function NotePreview({
  note,
  onEdit,
  onDelete,
}: {
  note: NoteRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-background/80 px-6 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{note.title}</h2>
          {note.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {note.tags.map((t) => (
                <TagPill key={t} tag={t} />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ExportButton nodeId={note.id} label="Word" />
          <ShareControl nodeId={note.id} />
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete note"
          >
            <Trash2 />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scrollbar-thin px-6 py-5">
        <article className="prose prose-sm dark:prose-invert max-w-none prose-accent">
          {note.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No content yet. Click <span className="font-medium not-italic text-foreground">Edit</span> to add some.
            </p>
          )}
        </article>

        {/* Digest notes store the same text as content and summary (the note IS
            a summary) — skip the box rather than render the body twice. */}
        {note.summary && note.summary.trim() !== note.content.trim() && (
          <aside className="rounded-md border border-border bg-muted/40 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3.5" aria-hidden /> Indexed summary
            </div>
            <p className="text-sm text-muted-foreground">{note.summary}</p>
          </aside>
        )}

        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          Updated {formatDateTime(note.updatedAt)} · created {formatDateTime(note.createdAt)}
        </div>
      </div>
    </div>
  );
}
