'use client';

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSONContent } from '@tiptap/react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerLeftUp,
  FolderInput,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { PageSort } from '@/lib/pages';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { TagPill } from '@/components/tag-pill';
import { TagInput } from '@/components/tag-input';
import { PageView } from '@/components/page-editor/page-view';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';
import { buildChildrenIndex } from './page-tree';
import type { PageRow } from '@mantle/content';

// Wire shape is the GET /api/pages mapper's output — single source of truth
// (the canonical row also carries `width`, unused by this list view). Drift
// between the mapper and what this screen renders is now a compile error.

type TagCount = { tag: string; count: number };

/** Droppable id for the "move to the top level" zone shown while dragging a
 *  nested page. A literal sentinel — page ids are uuids, so it never collides. */
const TOP_LEVEL_DROP_ID = '__pages_root__';

const SORT_LABELS: Record<PageSort, string> = {
  edited: 'Last edited',
  newest: 'Newest',
  oldest: 'Oldest',
  title: 'Title A–Z',
};

const SORTS: PageSort[] = ['edited', 'newest', 'oldest', 'title'];

type PagesListResponse = {
  mode: 'tree' | 'list';
  pages: PageRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: TagCount[];
};

export function PagesClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [navPending, startNav] = useTransition();

  // URL is the source of truth (matches the old SSR page); the data query keys
  // off these so a `go()` navigation re-fetches automatically.
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const activeTag = searchParams.get('tag')?.trim() || null;
  const sortParam = searchParams.get('sort');
  const sort: PageSort = SORTS.includes(sortParam as PageSort) ? (sortParam as PageSort) : 'edited';

  const listQuery = useQuery({
    queryKey: ['pages', { q: query, tag: activeTag, sort, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (activeTag) qs.set('tag', activeTag);
      if (sort !== 'edited') qs.set('sort', sort);
      if (page > 1) qs.set('page', String(page));
      const s = qs.toString();
      return apiFetch<PagesListResponse>(`/api/pages${s ? `?${s}` : ''}`);
    },
    placeholderData: (prev) => prev, // keep the list visible while paging/filtering
  });

  const mode = listQuery.data?.mode ?? (query || activeTag ? 'list' : 'tree');
  const pages = listQuery.data?.pages ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.pageSize ?? 50;
  const tags = listQuery.data?.tags ?? [];

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ title: string; tags: string[] }>({ title: '', tags: [] });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PageRow | null>(null);
  // Authoritative descendant count for the delete warning — fetched on open so
  // it's accurate even in filtered/paginated 'list' mode (where the client
  // doesn't hold the whole tree). null = not yet loaded.
  const [deleteDescendants, setDeleteDescendants] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [searchInput, setSearchInput] = useState(query);

  // Draggable list-pane width (md+). Default 300px; persisted so it sticks.
  const WIDTH_KEY = 'mantle:pages-list-width';
  const LIST_MIN = 220;
  const LIST_MAX = 560;
  const gridRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(300);

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(v) && v >= LIST_MIN && v <= LIST_MAX) setListWidth(v);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(listWidth)));
    } catch {
      // ignore
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
    // Suppress text selection + force the resize cursor for the whole drag.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selected = pages.find((p) => p.id === selectedId) ?? pages[0] ?? null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Tree index: parent id → sorted children (null key = top-level). See
  // buildChildrenIndex for the orphan-as-root + cycle-safety rules.
  const childrenByParent = useMemo(() => buildChildrenIndex(pages), [pages]);

  const hasChildren = (id: string) => (childrenByParent.get(id)?.length ?? 0) > 0;
  const deleteHasChildren = deleteTarget ? hasChildren(deleteTarget.id) : false;
  useEffect(() => {
    if (!deleteTarget) {
      setDeleteDescendants(null);
      return;
    }
    let cancelled = false;
    setDeleteDescendants(null);
    apiFetch<{ count?: number }>(`/api/pages/${deleteTarget.id}/descendant-count`)
      .then((d) => {
        if (!cancelled && d) setDeleteDescendants(typeof d.count === 'number' ? d.count : 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deleteTarget]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Drag-to-reparent (tree mode) ─────────────────────────────────────────
  // The whole hierarchy is client-side here, so re-parenting is a drag of one
  // row onto another (→ nest under it) or onto the top-level zone (→ un-nest).
  // There's no manual sibling ordering (children sort by title), so a drop is
  // purely "set parent". A 6px activation distance keeps plain clicks selecting.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRow = activeId ? (pages.find((p) => p.id === activeId) ?? null) : null;

  /** All pages beneath `id` in the tree (excludes `id` itself). Cycle-safe. */
  const descendantIdsOf = useMemo(() => {
    return (id: string): Set<string> => {
      const out = new Set<string>();
      const stack = [...(childrenByParent.get(id) ?? [])];
      while (stack.length) {
        const n = stack.pop()!;
        if (out.has(n.id)) continue;
        out.add(n.id);
        const kids = childrenByParent.get(n.id);
        if (kids) stack.push(...kids);
      }
      return out;
    };
  }, [childrenByParent]);

  // Targets you can't drop onto: the dragged page itself + its descendants
  // (would create a cycle). Recomputed when a drag starts.
  const invalidDropIds = useMemo(() => {
    if (!activeId) return new Set<string>();
    const s = descendantIdsOf(activeId);
    s.add(activeId);
    return s;
  }, [activeId, descendantIdsOf]);

  const move = async (id: string, parentId: string | null) => {
    // Surface the result immediately, then re-pull the SSR tree (the same
    // refresh pattern create/delete use). Expand the new parent so the moved
    // page is visible where it landed instead of hiding in a collapsed branch.
    try {
      await apiSend(`/api/pages/${id}/move`, 'POST', { parentId });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Could not move page');
      return;
    }
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
    toast.success(parentId ? 'Page moved' : 'Moved to top level');
    void queryClient.invalidateQueries({ queryKey: ['pages'] });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const sourceId = String(active.id);
    const src = pages.find((p) => p.id === sourceId);
    if (!src) return;
    const targetParent = over.id === TOP_LEVEL_DROP_ID ? null : String(over.id);
    if (targetParent === (src.parentId ?? null)) return; // already there — no-op
    // Belt-and-braces with the disabled drop targets + the server cycle guard.
    if (targetParent && (targetParent === sourceId || descendantIdsOf(sourceId).has(targetParent))) {
      toast.error("Can't move a page into one of its own sub-pages");
      return;
    }
    void move(sourceId, targetParent);
  };

  const buildHref = (over: {
    page?: number;
    tag?: string | null;
    q?: string | null;
    sort?: PageSort;
  }) => {
    const nextTag = over.tag !== undefined ? over.tag : activeTag;
    const nextQ = over.q !== undefined ? over.q : query || null;
    const nextPage = over.page !== undefined ? over.page : page;
    const nextSort = over.sort !== undefined ? over.sort : sort;
    const params = new URLSearchParams();
    if (nextTag) params.set('tag', nextTag);
    if (nextQ) params.set('q', nextQ);
    if (nextPage && nextPage > 1) params.set('page', String(nextPage));
    if (nextSort && nextSort !== 'edited') params.set('sort', nextSort); // 'edited' is default
    const s = params.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  const go = (over: Parameters<typeof buildHref>[0]) =>
    startNav(() => router.push(buildHref(over)));

  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput.trim() === query) return;
      go({ q: searchInput.trim() || null, page: 1 });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error('Title is required');
      return;
    }
    setSaving(true);
    try {
      let created: PageRow;
      try {
        ({ page: created } = await apiSend<{ page: PageRow }>('/api/pages', 'POST', {
          title: form.title.trim(),
          tags: form.tags,
        }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        toast.error(e instanceof Error ? e.message : 'request failed');
        return;
      }
      setForm({ title: '', tags: [] });
      setOpen(false);
      toast.success('Page created');
      // Refresh the list cache so the new page is present on navigate-back.
      void queryClient.invalidateQueries({ queryKey: ['pages'] });
      // New pages open straight into the editor.
      router.push(`/pages/${created.id}`);
    } finally {
      setSaving(false);
    }
  };

  // Create a sub-page under `parentId` and open it (create & edit, like New).
  const createChild = async (parentId: string) => {
    let created: PageRow;
    try {
      ({ page: created } = await apiSend<{ page: PageRow }>('/api/pages', 'POST', {
        title: 'Untitled page',
        parentId,
      }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Could not create sub-page');
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['pages'] }); // keep the list fresh
    router.push(`/pages/${created.id}`);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiSend(`/api/pages/${deleteTarget.id}`, 'DELETE');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Could not delete page');
      return;
    }
    toast.success(
      deleteDescendants && deleteDescendants > 0
        ? `Page and ${deleteDescendants} sub-page${deleteDescendants === 1 ? '' : 's'} deleted`
        : deleteHasChildren
          ? 'Page and sub-pages deleted'
          : 'Page deleted',
    );
    if (selectedId === deleteTarget.id) setSelectedId(null);
    void queryClient.invalidateQueries({ queryKey: ['pages'] });
  };

  // Flatten the tree into rows honoring expand/collapse state.
  const renderTree = (parentId: string | null, depth: number): ReactNode[] => {
    const kids = childrenByParent.get(parentId) ?? [];
    const rows: ReactNode[] = [];
    for (const p of kids) {
      const kidHasChildren = hasChildren(p.id);
      const isExpanded = expanded.has(p.id);
      rows.push(
        <TreeRow
          key={p.id}
          row={p}
          depth={depth}
          hasChildren={kidHasChildren}
          expanded={isExpanded}
          selected={selected?.id === p.id}
          allPages={pages}
          descendantIdsOf={descendantIdsOf}
          disabledDrop={invalidDropIds.has(p.id)}
          dragging={activeId === p.id}
          onToggle={() => toggle(p.id)}
          onSelect={() => setSelectedId(p.id)}
          onAddChild={() => void createChild(p.id)}
          onDelete={() => setDeleteTarget(p)}
          onMove={(parentId) => void move(p.id, parentId)}
        />,
      );
      if (kidHasChildren && isExpanded) rows.push(...renderTree(p.id, depth + 1));
    }
    return rows;
  };

  const emptyState = (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
      {mode === 'list'
        ? 'No pages match your search or filter.'
        : 'No pages yet. Click “New” to start writing.'}
    </div>
  );

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
          {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load pages.'}
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
      // Inline template columns drive the draggable left width. Only takes
      // effect at md+ (below md the container is block-stacked, not a grid).
      style={{ gridTemplateColumns: `${listWidth}px minmax(0, 1fr)` }}
    >
      {/* Draggable divider between list + preview (md+ only). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize list"
        onPointerDown={startResize}
        className="absolute inset-y-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/20 md:block"
        style={{ left: `${listWidth}px` }}
      />
      {/* ── Left: list / tree ───────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search pages…"
                className="pl-8"
              />
            </div>
            <Button onClick={() => setOpen(true)}>
              <Plus /> New
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-muted-foreground"
                  title="Sort pages"
                >
                  <ArrowUpDown className="size-3.5" />
                  {SORT_LABELS[sort]}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(v) => go({ sort: v as PageSort, page: 1 })}
                >
                  {(Object.keys(SORT_LABELS) as PageSort[]).map((s) => (
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
                onSelect={(t) => go({ tag: t, page: 1 })}
              />
            )}

            {activeTag && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-muted-foreground"
                onClick={() => go({ tag: null, page: 1 })}
                title="Clear tag filter"
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        <div
          className={cn(
            'p-3 transition-opacity md:flex-1 md:overflow-y-auto md:scrollbar-thin',
            mode === 'list' && 'space-y-2',
            mode === 'tree' && 'space-y-0.5',
            navPending && 'opacity-60',
          )}
        >
          {pages.length === 0 ? (
            emptyState
          ) : mode === 'tree' ? (
            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={(e) => setActiveId(String(e.active.id))}
              onDragEnd={onDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              {/* Un-nest target — only while dragging a page that has a parent. */}
              {activeRow && activeRow.parentId !== null && <TopLevelDropZone />}
              {renderTree(null, 0)}
              <DragOverlay dropAnimation={null}>
                {activeRow ? <DragGhost row={activeRow} /> : null}
              </DragOverlay>
            </DndContext>
          ) : (
            pages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={cn(
                      'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-muted/50',
                      selected?.id === p.id && 'border-l-primary',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className="mt-0.5 size-4 shrink-0 text-center text-sm leading-4"
                        aria-hidden
                      >
                        {p.icon ?? '📄'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.title}</div>
                        {p.summary && (
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {p.summary}
                          </p>
                        )}
                        {p.tags.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {p.tags.map((t) => (
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

        {total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {total} {total === 1 ? 'page' : 'pages'}
            </span>
            {mode === 'list' && (
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
            )}
          </div>
        )}
      </div>

      {/* ── Right: preview ─────────────────────────────────────────── */}
      <div className="md:h-full md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <PagePreview key={selected.id} row={selected} onDelete={() => setDeleteTarget(selected)} />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a page to preview.
          </div>
        )}
      </div>

      {/* New page dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New page</DialogTitle>
            <DialogDescription>
              Give it a title — you’ll write the body in the editor.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tags">Tags</Label>
              <TagInput
                id="tags"
                value={form.tags}
                onChange={(t) => setForm({ ...form, tags: t })}
                placeholder="Type and press comma or Enter…"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={saving}>Create page</SubmitButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDescendants && deleteDescendants > 0
                ? `This also permanently deletes ${deleteDescendants} nested page${deleteDescendants === 1 ? '' : 's'}. This can’t be undone.`
                : deleteHasChildren
                  ? 'This page and all of its sub-pages will be deleted. This can’t be undone.'
                  : 'This can’t be undone.'}
            </AlertDialogDescription>
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

/** One row in the hierarchy tree. Chevron toggles expand; the body selects
 *  (drives the preview); the left grip drags the page to re-parent it; hover
 *  reveals move / add-sub-page / delete. The row is a drop target — dropping
 *  another page onto it nests that page underneath. Indentation is an inline
 *  `paddingLeft` (depth-driven, so not a Tailwind dynamic class). */
function TreeRow({
  row,
  depth,
  hasChildren,
  expanded,
  selected,
  allPages,
  descendantIdsOf,
  disabledDrop,
  dragging,
  onToggle,
  onSelect,
  onAddChild,
  onDelete,
  onMove,
}: {
  row: PageRow;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  allPages: PageRow[];
  descendantIdsOf: (id: string) => Set<string>;
  disabledDrop: boolean;
  dragging: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onAddChild: () => void;
  onDelete: () => void;
  onMove: (parentId: string | null) => void;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: row.id, disabled: disabledDrop });
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
  } = useDraggable({ id: row.id });

  // Valid "Move to…" parents: every other page except this one and its own
  // descendants (those would cycle). Built lazily — the menu mounts on open.
  const moveTargets = useMemo(() => {
    const bad = descendantIdsOf(row.id);
    return allPages
      .filter((p) => p.id !== row.id && !bad.has(p.id))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [allPages, descendantIdsOf, row.id]);

  const nesting = isOver && !disabledDrop;

  return (
    <div
      ref={setDropRef}
      className={cn(
        'group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-muted/50',
        selected && 'bg-accent/60',
        nesting && 'ring-2 ring-inset ring-primary bg-primary/10',
        dragging && 'opacity-40',
      )}
    >
      {/* Grip stays in a fixed left gutter for every row — depth indents the
          chevron + title below, not the handle, so all handles line up. */}
      <button
        type="button"
        ref={setDragRef}
        {...listeners}
        {...attributes}
        aria-label={`Drag to move “${row.title}”`}
        title="Drag to move"
        className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 active:cursor-grabbing focus-visible:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </button>

      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
          style={{ marginLeft: depth * 16 }}
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ) : (
        <span className="size-6 shrink-0" aria-hidden style={{ marginLeft: depth * 16 }} />
      )}

      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
      >
        <span className="size-4 shrink-0 text-center text-sm leading-4" aria-hidden>
          {row.icon ?? '📄'}
        </span>
        <span className="min-w-0 truncate text-sm font-medium">{row.title}</span>
      </button>

      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Move page"
              title="Move to…"
            >
              <FolderInput />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
            <DropdownMenuItem disabled={row.parentId === null} onClick={() => onMove(null)}>
              <CornerLeftUp />
              Top level
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {moveTargets.length === 0 ? (
              <DropdownMenuItem disabled>No other pages</DropdownMenuItem>
            ) : (
              moveTargets.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  disabled={t.id === row.parentId}
                  onClick={() => onMove(t.id)}
                >
                  <span className="size-4 shrink-0 text-center text-sm leading-4" aria-hidden>
                    {t.icon ?? '📄'}
                  </span>
                  <span className="min-w-0 truncate">{t.title}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onAddChild}
          aria-label="Add sub-page"
          title="Add sub-page"
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label="Delete page"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/** The floating preview that follows the cursor while dragging a tree row. */
function DragGhost({ row }: { row: PageRow }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-sm font-medium shadow-lg">
      <GripVertical className="size-3.5 text-muted-foreground" />
      <span aria-hidden>{row.icon ?? '📄'}</span>
      <span className="max-w-48 truncate">{row.title}</span>
    </div>
  );
}

/** Drop band at the top of the tree (shown only while dragging a nested page)
 *  that re-parents the dragged page to the top level. */
function TopLevelDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: TOP_LEVEL_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mb-1 rounded-md border border-dashed px-3 py-2 text-center text-xs transition-colors',
        isOver
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground',
      )}
    >
      Drop here to move to the top level
    </div>
  );
}

/** Searchable tag filter — Popover + Command (cmdk) combobox. Replaces the
 *  inline pill row, which got unwieldy past a handful of tags. cmdk filters the
 *  list by each item's `value` as you type; selecting drives the URL `tag`
 *  param (SSR filtering), and re-picking the active tag clears it. */
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
          <CommandList className="max-h-72">
            <CommandEmpty className="px-3 py-6 text-center text-xs text-muted-foreground">
              No tags found.
            </CommandEmpty>
            <CommandGroup>
              {/* Sentinel value so a tag search doesn't accidentally match it. */}
              <CommandItem value="__all_pages__" onSelect={() => choose(null)}>
                <Check className={cn('size-4', activeTag === null ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1">All pages</span>
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
                  <span className="ml-2 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t.count}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Right-pane read-only preview. Fetches the full document for the selected
 *  page (the list omits the body to stay lean) and renders it read-only.
 *  Prefers the uncommitted DRAFT over the published doc so a page you've edited
 *  but not committed — especially a brand-new page whose published doc is still
 *  empty — shows its content here instead of looking blank. This is render-only
 *  (no indexing); the committed doc stays the canonical version everywhere else
 *  (public share, MCP). A badge flags that the preview is showing a draft. */
function PagePreview({ row, onDelete }: { row: PageRow; onDelete: () => void }) {
  const [doc, setDoc] = useState<JSONContent | null>(null);
  const [isDraft, setIsDraft] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ page: { doc: JSONContent; draft: JSONContent | null } }>(`/api/pages/${row.id}`)
      .then(({ page }) => {
        if (!cancelled) {
          setDoc(page.draft ?? page.doc);
          setIsDraft(!!page.draft);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-xl font-semibold">
          <span aria-hidden>{row.icon ?? '📄'}</span>
          <span className="min-w-0 truncate">{row.title}</span>
          {isDraft && (
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Draft · uncommitted
            </span>
          )}
        </h2>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/pages/${row.id}`}>
              <Pencil /> Edit
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete page"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {row.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((t) => (
            <TagPill key={t} tag={t} />
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : doc ? (
        <PageView content={doc} />
      ) : (
        <p className="text-sm italic text-muted-foreground">Couldn’t load this page.</p>
      )}

      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Updated {formatDateTime(row.updatedAt)} · created {formatDateTime(row.createdAt)}
      </div>
    </div>
  );
}
