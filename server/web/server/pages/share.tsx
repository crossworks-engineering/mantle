import type { Context, Hono } from 'hono';
import { renderToStaticMarkup } from 'react-dom/server';
import { shareModeOf } from '@mantle/content';
import { loadAppearanceAttrs } from './appearance';
import { resolveActiveShareByToken, recordShareView, loadShareView } from '@/lib/shares';
import { resolveShareVisitor } from '@/lib/team-gate';
import { PagePresenter } from '@/components/share/page-presenter';
import { NotePresenter } from '@mantle/web-ui/share/note-presenter';
import { FilePresenter } from '@mantle/web-ui/share/file-presenter';
import { TaskPresenter } from '@mantle/web-ui/share/task-presenter';
import { EventPresenter } from '@mantle/web-ui/share/event-presenter';
import { FolderPresenter, loadFolderListing } from '@/components/share/folder-presenter';
import { FormulaPresenter } from '@mantle/web-ui/share/formula-presenter';
import { DrawPresenter } from '@mantle/web-ui/share/draw-presenter';
import { htmlPage, islandDiv, shareShell } from './template';

/**
 * The public /s/[token] share surface — the port of app/s/[token]/page.tsx.
 * Static presenters (page/note/file/task/event/folder) render to HTML via
 * react-dom/server; the interactive three (app, table, token prompt — 'use
 * client' under Next too) mount as client islands from
 * /share-runtime/islands.js. Always resolved per request against the live DB —
 * a revoked link must 404 immediately.
 */

async function renderShare(c: Context): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const url = new URL(c.req.url);
  const p = url.searchParams.get('p') ?? '';

  // Invalid / revoked / expired all 404 — never reveal that a token existed.
  const share = await resolveActiveShareByToken(token);
  if (!share) return c.notFound();
  const view = await loadShareView(share);
  if (!view) return c.notFound();

  const heading = 'title' in view ? view.title : view.filename;
  // The owner's brand renders into the <html> tag — a share page is the
  // BRAIN's surface, so the owner's theme + fonts are the only appearance.
  const appearance = await loadAppearanceAttrs(share.ownerId);
  const gated = shareModeOf(share) === 'team';

  // Team-mode shares gate on a live team session; without one the visitor
  // gets the token prompt instead of the content. Unfurl metadata stays
  // generic for gated shares — a team title must not leak to crawlers.
  const visitor = await resolveShareVisitor(c.req.raw.headers.get('cookie'), share);
  const meta = {
    title: gated && !visitor ? 'Shared' : `${heading} · Shared`,
    noindex: true,
    og:
      gated && !visitor
        ? { title: 'Shared', description: 'Shared via Mantle' }
        : { title: heading, description: 'Shared via Mantle' },
    appearance,
  };

  if (!visitor) {
    return c.html(
      htmlPage(
        { ...meta, islands: true },
        islandDiv('team-token-prompt', { shareToken: token, title: heading }),
      ),
    );
  }

  void recordShareView(share.id); // fire-and-forget view counter

  const assetUrl = (fileId: string) => `/s/${token}/a/${fileId}`;
  const drawUrl = (drawId: string) => `/s/${token}/draw/${encodeURIComponent(drawId)}`;

  let body: string | null;
  let islands = false;
  switch (view.kind) {
    case 'page':
      body = renderToStaticMarkup(
        <PagePresenter view={view} assetUrl={assetUrl} drawUrl={drawUrl} />,
      );
      break;
    case 'note':
      body = renderToStaticMarkup(<NotePresenter view={view} />);
      break;
    case 'file':
      body = renderToStaticMarkup(<FilePresenter view={view} assetUrl={assetUrl} />);
      break;
    case 'task':
      body = renderToStaticMarkup(<TaskPresenter view={view} />);
      break;
    case 'event':
      body = renderToStaticMarkup(<EventPresenter view={view} />);
      break;
    case 'app':
      body = islandDiv('app', { view, token });
      islands = true;
      break;
    case 'table':
      body = islandDiv('table', { view, token });
      islands = true;
      break;
    case 'formula':
      // Static spec + warnings, with the calculator embedded as an island —
      // the equations and the `unverified` notices must render with no JS.
      body = renderToStaticMarkup(
        <FormulaPresenter
          view={view}
          calculator={
            <div
              dangerouslySetInnerHTML={{
                __html: islandDiv('formula-calculator', { token, signature: view.signature }),
              }}
            />
          }
        />,
      );
      islands = true;
      break;
    case 'draw':
      // Fully static — the snapshot is an <img> pointing at /s/:token/draw, so
      // no JS and no third-party markup ever lands in this document.
      body = renderToStaticMarkup(<DrawPresenter view={view} src={`/s/${token}/draw`} />);
      break;
    case 'folder': {
      const listing = await loadFolderListing(share.ownerId, view, p);
      body = renderToStaticMarkup(
        <FolderPresenter
          view={view}
          listing={listing}
          assetUrl={assetUrl}
          makeSubHref={(sub) => (sub ? `/s/${token}?p=${encodeURIComponent(sub)}` : `/s/${token}`)}
        />,
      );
      break;
    }
    default:
      body = null;
  }
  if (body === null) return c.notFound();

  return c.html(htmlPage({ ...meta, islands }, shareShell(body)));
}

export function mountShare(app: Hono): void {
  app.get('/s/:token', renderShare);
}
