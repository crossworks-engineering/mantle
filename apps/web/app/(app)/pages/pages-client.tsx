'use client';

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { JSONContent } from '@tiptap/react';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PageSort } from '@/lib/pages';
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

type PageRow = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: 'private' | 'public';
  createdAt: string;
  updatedAt: string;
};

type TagCount = { tag: string; count: number };

const SORT_LABELS: Record<PageSort, string> = {
  edited: 'Last edited',
  newest: 'Newest',
  oldest: 'Oldest',
  title: 'Title A–Z',
};

export function PagesClient({
  mode,
  pages,
  total,
  page,
  pageSize,
  tags,
  activeTag,
  query,
  sort,
}: {
  /** 'tree' = full hierarchy (no filter active); 'list' = flat paginated
   *  results while searching / tag-filtering. */
  mode: 'tree' | 'list';
  pages: PageRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: TagCount[];
  activeTag: string | null;
  query: string;
  sort: PageSort;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [navPending, startNav] = useTransition();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ title: string; tags: string[] }>({ title: '', tags: [] });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PageRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [searchInput, setSearchInput] = useState(query);

  // Tag filter row collapses to a single line; a toggle reveals the rest.
  // `tagsOverflow` (measured while collapsed) gates the toggle so it only shows
  // when the tags actually wrap past one row.
  const tagRowRef = useRef<HTMLDivElement>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [tagsOverflow, setTagsOverflow] = useState(false);

  useEffect(() => {
    if (tagsExpanded) return; // keep the toggle visible while expanded
    const el = tagRowRef.current;
    if (!el) return;
    const check = () => setTagsOverflow(el.scrollHeight - el.clientHeight > 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags, tagsExpanded]);

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

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      const res = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: form.title.trim(), tags: form.tags }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? `request failed (${res.status})`);
        return;
      }
      const { page: created } = (await res.json()) as { page: PageRow };
      setForm({ title: '', tags: [] });
      setOpen(false);
      toast.success('Page created');
      // New pages open straight into the editor.
      router.push(`/pages/${created.id}`);
    } finally {
      setSaving(false);
    }
  };

  // Create a sub-page under `parentId` and open it (create & edit, like New).
  const createChild = async (parentId: string) => {
    const res = await fetch('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled page', parentId }),
    });
    if (!res.ok) {
      toast.error('Could not create sub-page');
      return;
    }
    const { page: created } = (await res.json()) as { page: PageRow };
    router.push(`/pages/${created.id}`);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/pages/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete page');
      return;
    }
    toast.success(deleteHasChildren ? 'Page and sub-pages deleted' : 'Page deleted');
    if (selectedId === deleteTarget.id) setSelectedId(null);
    startNav(() => router.refresh());
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
          onToggle={() => toggle(p.id)}
          onSelect={() => setSelectedId(p.id)}
          onAddChild={() => void createChild(p.id)}
          onDelete={() => setDeleteTarget(p)}
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
            <div className="flex items-start gap-1.5">
              <div
                ref={tagRowRef}
                className={cn(
                  'flex flex-1 flex-wrap items-center gap-1.5',
                  !tagsExpanded && 'max-h-7 overflow-hidden',
                )}
              >
                <Button
                  size="sm"
                  variant={activeTag ? 'outline' : 'default'}
                  className="h-7 rounded-full px-3"
                  onClick={() => go({ tag: null, page: 1 })}
                >
                  All
                </Button>
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
            </div>
          )}
        </div>

        <div
          className={cn(
            'p-3 transition-opacity md:flex-1 md:overflow-y-auto md:scrollbar-thin',
            mode === 'list' && 'space-y-2',
            mode === 'tree' && 'space-y-0.5',
            navPending && 'opacity-60',
          )}
        >
          {pages.length === 0
            ? emptyState
            : mode === 'tree'
              ? renderTree(null, 0)
              : pages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={cn(
                      'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-accent/40',
                      selected?.id === p.id && 'border-l-primary bg-accent/50',
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
                ))}
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
              {deleteHasChildren
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
 *  (drives the preview); hover reveals add-sub-page + delete. Indentation is
 *  an inline `paddingLeft` (depth-driven, so not a Tailwind dynamic class). */
function TreeRow({
  row,
  depth,
  hasChildren,
  expanded,
  selected,
  onToggle,
  onSelect,
  onAddChild,
  onDelete,
}: {
  row: PageRow;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onAddChild: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent/40',
        selected && 'bg-accent/60',
      )}
      style={{ paddingLeft: depth * 16 }}
    >
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ) : (
        <span className="size-6 shrink-0" aria-hidden />
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

/** Right-pane read-only preview. Fetches the full document for the selected
 *  page (the list omits the body to stay lean) and renders it read-only. */
function PagePreview({ row, onDelete }: { row: PageRow; onDelete: () => void }) {
  const [doc, setDoc] = useState<JSONContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/pages/${row.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(({ page }: { page: { doc: JSONContent } }) => {
        if (!cancelled) {
          setDoc(page.doc);
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
