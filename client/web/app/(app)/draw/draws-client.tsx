'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, PenTool, Plus, Search, Trash2, X } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { ListPager } from '@mantle/web-ui/layout/list-pager';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { TagPill } from '@mantle/web-ui/tag-pill';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import { ExportMenu } from '@/components/export/export-menu';
import { useListNav } from '@/lib/use-list-nav';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { useToast } from '@mantle/web-ui/ui/toast';
import { syncSelectionParam } from '@/lib/url-sync';
import { cn } from '@mantle/web-ui/lib/utils';
import { drawSnapshotClass } from '@/components/draw/snapshot-theme';

type DrawRow = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  description: string | null;
  summary: string | null;
  visibility: 'private' | 'public';
  hasSvg: boolean;
  hasDraft: boolean;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = {
  draws: DrawRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: { tag: string; count: number }[];
};

export function DrawsClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { pending, go } = useListNav();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const tag = searchParams.get('tag')?.trim() ?? '';
  const urlId = searchParams.get('id')?.trim() || null;

  // Selection lives in client state; `select` mirrors it to the URL with
  // replaceState (no navigation) — the param is an entry point, not truth.
  const [selectedId, setSelectedId] = useState<string | null>(urlId);
  useEffect(() => {
    if (urlId) setSelectedId(urlId);
  }, [urlId]);

  const [deleteTarget, setDeleteTarget] = useState<DrawRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteActive() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await apiSend(`/api/draws/${deleteTarget.id}`, 'DELETE');
      toast.success('Drawing deleted');
      setSelectedId(null);
      syncSelectionParam('id', null);
      await queryClient.invalidateQueries({ queryKey: ['draws'] });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the drawing');
    } finally {
      setDeleting(false);
    }
  }

  const [searchInput, setSearchInput] = useState(query);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement === searchRef.current) return;
    setSearchInput(query);
  }, [query]);
  useEffect(() => {
    if (searchInput === query) return;
    const t = setTimeout(() => go({ q: searchInput || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [searchInput, query, go]);

  const listQuery = useQuery({
    queryKey: ['draws', { q: query, tag, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (tag) qs.set('tag', tag);
      if (page > 1) qs.set('page', String(page));
      const suffix = qs.toString();
      return apiFetch<ListResponse>(`/api/draws${suffix ? `?${suffix}` : ''}`);
    },
  });

  const draws = useMemo(() => listQuery.data?.draws ?? [], [listQuery.data]);
  const activeId = selectedId ?? draws[0]?.id ?? null;
  const active = draws.find((d) => d.id === activeId) ?? null;

  function select(id: string) {
    setSelectedId(id);
    syncSelectionParam('id', id);
  }

  async function createDraw() {
    if (creating) return;
    setCreating(true);
    try {
      const { draw } = await apiSend<{ draw: { id: string } }>('/api/draws', 'POST', {
        title: 'Untitled drawing',
      });
      await queryClient.invalidateQueries({ queryKey: ['draws'] });
      router.push(`/draw/${draw.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the drawing');
      setCreating(false);
    }
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (listQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Could not load drawings.</p>
        <Button variant="outline" onClick={() => void listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="relative md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: list ─────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-2 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search drawings…"
                className="pl-8"
              />
            </div>
            <Button size="sm" onClick={() => void createDraw()} disabled={creating}>
              {creating ? <Spinner /> : <Plus />}
              New
            </Button>
          </div>
          {tag ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => go({ tag: null, page: null })}
              title="Clear the tag filter"
            >
              <X />
              {tag}
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-thin p-3">
          {draws.length === 0 && (query || tag) ? (
            <div className="space-y-3 px-1 py-8 text-center">
              <p className="text-sm text-muted-foreground">Nothing matches these filters.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => go({ q: null, tag: null, page: null })}
              >
                Clear filters
              </Button>
            </div>
          ) : draws.length === 0 ? (
            <div className="space-y-3 px-1 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No drawings yet. Sketch an idea, an architecture, a plan. Commits land in the brain
                like every other content type.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void createDraw()}
                disabled={creating}
              >
                {creating ? <Spinner /> : <Plus />}
                New drawing
              </Button>
            </div>
          ) : (
            draws.map((d) => (
              <div
                key={d.id}
                className={cn(
                  'rounded-lg border border-l-[3px] border-border border-l-border bg-card',
                  activeId === d.id && 'border-l-primary',
                )}
              >
                <button
                  onClick={() => select(d.id)}
                  data-mark-id={d.id}
                  data-mark-kind="draw"
                  data-mark-label={d.title}
                  className="block w-full rounded-lg p-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start gap-2">
                    {d.icon ? (
                      <span className="mt-0.5 w-4 shrink-0 text-center text-sm leading-4">
                        {d.icon}
                      </span>
                    ) : (
                      <PenTool className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-sm font-medium">{d.title}</span>
                        {/* A dot, not a word: the row is a scan target and the
                            preview pane carries the full explanation. */}
                        {d.hasDraft && (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-primary"
                            title="Uncommitted edits"
                            aria-label="Uncommitted edits"
                          />
                        )}
                      </div>
                      {d.summary ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {d.summary}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </button>
                {d.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pl-9">
                    {d.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => go({ tag: t === tag ? null : t, page: null })}
                        title={t === tag ? `Clear the ${t} filter` : `Show only ${t}`}
                      >
                        <TagPill
                          tag={t}
                          className={cn(
                            'transition-opacity hover:opacity-80',
                            t === tag && 'ring-1 ring-primary',
                          )}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <ListPager
          page={page}
          total={listQuery.data?.total ?? 0}
          pageSize={listQuery.data?.pageSize ?? 50}
          pending={pending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* ── Right: preview pane ────────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto">
        {active ? (
          <DrawPreview
            key={active.id}
            draw={active}
            onOpen={() => router.push(`/draw/${active.id}`)}
            onDelete={() => setDeleteTarget(active)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a drawing.</p>
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this drawing?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title ?? ''}” and its brain index will be removed. Images embedded
              from the files area are kept there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={() => void deleteActive()}
            >
              {deleting ? 'Deleting…' : 'Delete drawing'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Read-only preview: the committed SVG snapshot plus metadata and the Open
 * button. No canvas is mounted here, so browsing the list never pays the
 * editor chunk.
 *
 * The snapshot renders as an IMAGE, not as injected markup. This screen is the
 * owner's authenticated session, which makes it the worst place to inline
 * third-party-shaped SVG: referenced as an image, the browser treats the file
 * as a separate, script-disabled document, so nothing inside it can touch this
 * page. The bytes still arrive over an authenticated fetch (an image element's
 * src can't carry a bearer in the detached deployment), then become a blob URL.
 */
function DrawPreview({
  draw,
  onOpen,
  onDelete,
}: {
  draw: DrawRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const svgQuery = useQuery({
    queryKey: ['draws', draw.id, 'svg'],
    queryFn: () => apiFetch<{ svg: string | null }>(`/api/draws/${draw.id}/svg`).then((r) => r.svg),
    // Deliberately NOT gated on draw.hasSvg. A drawing with no snapshot is
    // exactly the case the render fallback exists for (an agent authored it,
    // or a client-side export failed), and gating the fetch on "a snapshot
    // already exists" meant that case could never heal from this screen. The
    // route answers an empty scene straight from SQL, so a drawing with
    // nothing on it still costs no browser session.
  });

  const svg = svgQuery.data;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!svg) {
      setSrc(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [svg]);

  return (
    // Full-width, start-aligned — the same clean preview shell as /pages
    // (no centred max-w column, actions top-right and out of the way).
    <div className="w-full space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-xl font-semibold">
            <span aria-hidden>{draw.icon ?? '✏️'}</span>
            <span className="min-w-0 truncate">{draw.title}</span>
            {/* Uncommitted edits exist but cannot be previewed: a draft is
                never rendered (rendering happens at commit, and the sidecar
                only ever draws the committed scene). Say so, rather than let
                the last commit read as "my work was lost" — same badge Pages
                uses for the same situation. */}
            {draw.hasDraft && (
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Draft · uncommitted
              </span>
            )}
          </h2>
          {/* The user's own one-liner wins; the extractor's summary fills in
              when none was written. */}
          {(draw.description ?? draw.summary) ? (
            <p className="mt-1 text-sm text-muted-foreground">{draw.description ?? draw.summary}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <ExportMenu nodeId={draw.id} kind="draw" />
          <Button asChild variant="outline" size="sm">
            <Link href={`/draw/${draw.id}`}>
              <Pencil /> Edit
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive-ink"
            onClick={onDelete}
            aria-label="Delete drawing"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {draw.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {draw.tags.map((t) => (
            <TagPill key={t} tag={t} />
          ))}
        </div>
      )}

      {svgQuery.isPending ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner />
        </div>
      ) : src ? (
        <>
          {draw.hasDraft && (
            <p className="text-xs text-muted-foreground">
              Showing the last commit — your newer edits are saved in the drawing.
            </p>
          )}
          {/* The snapshot fills its pane plainly — no border, mat or box; the
              SVG carries its own background. Still an IMAGE, never inline
              markup (see the loader note above). Under the dark theme it takes
              the canvas's own inversion so the preview matches the editor the
              drawing was made in — view-time only, nothing stored changes. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL of an owner-generated SVG; next/image can't take it */}
          <img src={src} alt={draw.title} className={cn('h-auto w-full', drawSnapshotClass(svg))} />
        </>
      ) : (
        <PreviewEmpty
          label={
            draw.hasDraft
              ? 'Your uncommitted edits are saved — open the drawing to carry on. The preview appears once you commit.'
              : 'Nothing to preview yet. Open the drawing and commit to create one.'
          }
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

function PreviewEmpty({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-muted/40"
    >
      <PenTool className="size-6" />
      {label}
    </button>
  );
}
