'use client';

/**
 * The /team INLINE share reader — renders shared content in the workspace's
 * own reader pane, no /s iframe. Fetches GET /s/<token>/view through teamFetch
 * (cookie same-origin, bearer cross-origin — the endpoint accepts both) and
 * mounts the same presenters the /s surface renders, from @mantle/web-ui/share.
 *
 * Two kinds differ from their /s twins:
 *  - `page` arrives as pre-rendered SANITIZED html + toc (renderPageDoc runs
 *    server-side only) and is injected verbatim into the editor CSS container;
 *  - `folder` navigates sub-folders by refetching `?p=` in place instead of
 *    anchor navigation.
 *
 * `app` mounts AppSandbox exactly like the /s island — the sandbox iframe
 * (opaque origin, allow-scripts only) is the app's EXECUTION boundary, not a
 * reading surface, and stays.
 *
 * Failure shapes: 401 = no live team session for a team-mode share (the pane
 * offers the top-level open, which can re-establish one via SSO); anything
 * else = a plain retry.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageOutline } from '@mantle/web-ui/page-outline';
import { teamFetch, upgradeTeamCookie } from '@mantle/web-ui/team-fetch';
import { buttonVariants } from '@mantle/web-ui/ui/button';
import { formatBytes } from '@mantle/web-ui/lib/format-bytes';
import { cn } from '@mantle/web-ui/lib/utils';
import type { ShareViewPayload, ShareFolderListing } from '@mantle/web-ui/share/view-payload';
import { NotePresenter } from '@mantle/web-ui/share/note-presenter';
import { DrawPresenter } from '@mantle/web-ui/share/draw-presenter';
import { TaskPresenter } from '@mantle/web-ui/share/task-presenter';
import { EventPresenter } from '@mantle/web-ui/share/event-presenter';
import { FilePresenter } from '@mantle/web-ui/share/file-presenter';
import { TablePresenter } from '@mantle/web-ui/share/table-presenter';
import { FormulaPresenter } from '@mantle/web-ui/share/formula-presenter';
import { FormulaCalculator } from '@mantle/web-ui/share/formula-calculator';
import { AppSandbox } from '@mantle/web-ui/app-sandbox/app-sandbox';
import { Download, File as FileIcon, Folder as FolderIcon, ExternalLink } from 'lucide-react';
import { OpenShare } from './open-on-server';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'unauthorized' }
  | { phase: 'gone' }
  | { phase: 'failed' }
  | { phase: 'ready'; view: ShareViewPayload };

const assetUrl = (token: string) => (fileId: string) => `/s/${token}/a/${fileId}`;

export function ShareReader({ token, title }: { token: string; title: string }) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  const load = useCallback(
    async (p?: string) => {
      setState({ phase: 'loading' });
      try {
        // Sessions minted in bearer mode hold no cookie yet — the view fetch
        // itself rides the bearer, but the content it renders loads
        // cookie-authenticated subresources (page images, downloads, rows,
        // the app bundle). Await the one-shot upgrade so the FIRST open
        // doesn't race the Set-Cookie; settles instantly when moot.
        await upgradeTeamCookie();
        const qs = p ? `?p=${encodeURIComponent(p)}` : '';
        const r = await teamFetch(`/s/${token}/view${qs}`, { cache: 'no-store' });
        if (r.status === 401) {
          setState({ phase: 'unauthorized' });
          return;
        }
        if (r.status === 404) {
          // Revoked / deleted since the list loaded — retry can't help.
          setState({ phase: 'gone' });
          return;
        }
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as { view: ShareViewPayload };
        setState({ phase: 'ready', view: d.view });
      } catch {
        setState({ phase: 'failed' });
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (state.phase !== 'ready') {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm text-muted-foreground">
            {state.phase === 'unauthorized'
              ? 'Your team session doesn’t cover this item here.'
              : state.phase === 'gone'
                ? 'This item is no longer shared.'
                : 'Could not load this item.'}
          </p>
          {state.phase === 'unauthorized' ? (
            <OpenShare token={token} className={cn(buttonVariants(), 'mt-4')}>
              <ExternalLink />
              <span className="max-w-56 truncate">Open {title}</span>
            </OpenShare>
          ) : state.phase === 'failed' ? (
            <button
              type="button"
              onClick={() => void load()}
              className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')}
            >
              Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const { view } = state;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin bg-background">
      {view.kind === 'page' && <PageReader view={view} />}
      {view.kind === 'note' && <NotePresenter view={view} />}
      {view.kind === 'draw' && <DrawPresenter view={view} />}
      {view.kind === 'task' && <TaskPresenter view={view} />}
      {view.kind === 'event' && <EventPresenter view={view} />}
      {view.kind === 'file' && <FilePresenter view={view} assetUrl={assetUrl(token)} />}
      {view.kind === 'table' && <TablePresenter view={view} token={token} />}
      {view.kind === 'formula' && (
        <FormulaPresenter
          view={view}
          calculator={<FormulaCalculator token={token} signature={view.signature} />}
        />
      )}
      {view.kind === 'app' && (
        <div className="p-4">
          <AppSandbox appId={view.appId} shareToken={token} />
        </div>
      )}
      {view.kind === 'folder' && (
        <FolderReader
          rootTitle={view.title}
          rootPath={view.path}
          listing={view.listing}
          token={token}
          onNavigate={(sub) => void load(sub)}
        />
      )}
    </div>
  );
}

/** Pre-rendered page html + outline — the inline twin of PagePresenter (which
 *  stays server-side with renderPageDoc). Same container classes, so the
 *  editor CSS in globals.css styles it identically. */
function PageReader({ view }: { view: Extract<ShareViewPayload, { kind: 'page' }> }) {
  const widthClass = view.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';
  return (
    <div className="flex w-full gap-8 px-6 py-12 md:py-16">
      {view.toc.length > 0 && (
        <aside className="hidden w-56 shrink-0 xl:block">
          <div className="sticky top-12 max-h-[calc(100dvh-6rem)] overflow-y-auto scrollbar-thin">
            <PageOutline entries={view.toc} />
          </div>
        </aside>
      )}
      <div className="min-w-0 flex-1">
        <article className={`mx-auto w-full ${widthClass}`}>
          <div
            className="ProseMirror prose dark:prose-invert prose-accent max-w-none"
            // Sanitized server-side by renderPageDoc — built from a known tag
            // set with all text + attributes escaped, never user HTML.
            dangerouslySetInnerHTML={{ __html: view.html }}
          />
        </article>
      </div>
    </div>
  );
}

/** Inline folder listing — FolderPresenter's layout with in-place navigation
 *  (refetch `?p=`) instead of anchor loads. Downloads keep real hrefs. */
function FolderReader({
  rootTitle,
  rootPath,
  listing,
  token,
  onNavigate,
}: {
  rootTitle: string;
  rootPath: string;
  listing: ShareFolderListing;
  token: string;
  onNavigate: (sub: string) => void;
}) {
  const { currentPath, folders, files } = listing;
  const relLabels =
    currentPath === rootPath ? [] : currentPath.slice(rootPath.length + 1).split('.');
  const crumbs = [
    { label: rootTitle, sub: '' },
    ...relLabels.map((label, i) => ({
      label: label.replace(/_/g, '-'),
      sub: relLabels.slice(0, i + 1).join('.'),
    })),
  ];
  const toAsset = assetUrl(token);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-6">
        <h1 className="text-center text-xl font-semibold tracking-tight">{rootTitle}</h1>
        <nav className="mt-2 flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={c.sub} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>/</span>}
              {i === crumbs.length - 1 ? (
                <span className="text-foreground">{c.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(c.sub)}
                  className="hover:text-foreground hover:underline"
                >
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </nav>
      </header>

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {folders.map((f) => {
          const childSub = f.path.slice(rootPath.length + 1);
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onNavigate(childSub)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <FolderIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.slug}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {f.fileCount} file{f.fileCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          );
        })}
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-3">
            <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{f.filename}</p>
              <p className="text-xs text-muted-foreground">
                {f.mimeType || 'file'} · {formatBytes(f.sizeBytes)}
              </p>
            </div>
            <a
              href={toAsset(f.id)}
              download={f.filename}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              <Download className="size-4" aria-hidden /> Download
            </a>
          </li>
        ))}
        {folders.length === 0 && files.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            This folder is empty.
          </li>
        )}
      </ul>
    </div>
  );
}
