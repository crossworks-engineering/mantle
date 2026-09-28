import type { Context, Hono } from 'hono';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRetiredTeamLinkToken } from '@mantle/content';
import { loadShareAppearance } from './appearance';
import { resolveActiveShareByToken, recordShareView, loadShareView } from '@/lib/shares';
import { PagePresenter } from '@/components/share/page-presenter';
import { NotePresenter } from '@mantle/share-ui/note-presenter';
import { FilePresenter } from '@mantle/share-ui/file-presenter';
import { TaskPresenter } from '@mantle/share-ui/task-presenter';
import { EventPresenter } from '@mantle/share-ui/event-presenter';
import { FolderPresenter, loadFolderListing } from '@/components/share/folder-presenter';
import { FormulaPresenter } from '@mantle/share-ui/formula-presenter';
import { DrawPresenter } from '@mantle/share-ui/draw-presenter';
import { escapeHtml, htmlPage, islandDiv, shareShell } from './template';
import { env } from '@mantle/config';

/**
 * The public /s/[token] share surface — the port of app/s/[token]/page.tsx.
 * Static presenters (page/note/file/task/event/folder) render to HTML via
 * react-dom/server; the interactive ones (app, table, the formula calculator,
 * 'use client' under Next too) mount as client islands from
 * /share-runtime/islands.js. Always resolved per request against the live DB —
 * a revoked link must 404 immediately.
 *
 * Every link here is open: team links were retired in member logins Phase 6
 * stage 6 (migration 0176 revoked them). An old team link answers a plain
 * "sign in as a member" page instead of the not-found, pointing at /login.
 */

/** The page an old team link shows (410): members sign in with their own
 *  logins now, and the item, if it is still at team, is in their Library. */
function retiredTeamLinkPage(): string {
  const heading = 'Sign in as a member';
  const body =
    'Team links are retired. Members of this brain sign in with their own login ' +
    'and find shared items in their Library. No login yet? Ask the brain admin for an invite.';
  return htmlPage(
    { title: heading, noindex: true },
    `<div class="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
<div class="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
<h1 class="text-base font-semibold">${escapeHtml(heading)}</h1>
<p class="mt-2 text-sm text-muted-foreground">${escapeHtml(body)}</p>
<p class="mt-4"><a href="/login" class="text-sm font-medium text-primary underline underline-offset-4">Sign in</a></p>
</div>
</div>`,
  );
}

async function renderShare(c: Context): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const url = new URL(c.req.url);
  const p = url.searchParams.get('p') ?? '';

  // Invalid / revoked / expired all 404 — never reveal that a token existed.
  // The one exception is a retired team link: its visitor was a team member,
  // and is told where to go now.
  const share = await resolveActiveShareByToken(token);
  if (!share) {
    if (await isRetiredTeamLinkToken(token)) return c.html(retiredTeamLinkPage(), 410);
    return c.notFound();
  }
  const view = await loadShareView(share);
  if (!view) return c.notFound();

  const heading = 'title' in view ? view.title : view.filename;
  // The owner's brand renders into the <html> tag — a share page is the
  // BRAIN's surface, so the owner's theme + fonts are the only appearance.
  // The owner also sets the DEFAULT mode and the Neat backdrop; the visitor's
  // own mode toggle (share-page.js) overlays the default, locally only.
  const {
    attrs: appearance,
    defaultMode,
    neatBackground,
  } = await loadShareAppearance(share.ownerId);
  const meta = {
    title: `${heading} · Shared`,
    noindex: true,
    og: { title: heading, description: 'Shared via Mantle' },
    appearance,
  };

  // One reader chrome for every shelled body. The licence key is the same
  // env var the client app uses, so one box config serves both surfaces.
  const shareMeta = {
    defaultMode,
    neat: neatBackground,
    neatLicense: env('MANTLE_NEAT_LICENSE_KEY'),
    readerChrome: true,
  };

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
      // Shell-less (see below), so the mount point paints the themed ground
      // itself — without it the page flashes user-agent default until the
      // island mounts and the frame boots.
      body = islandDiv('app', { view, token }, 'h-dvh bg-background text-foreground');
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

  // Apps skip the share shell: the presenter is h-dvh and the app owns the
  // whole viewport, so even the footer strip would sit below the fold as dead
  // scroll (it also gets mode stamping only — no toggle, no backdrop; the app
  // paints its own ground). Every other kind keeps the shell (scroll container
  // + footer) and the full reader chrome.
  return c.html(
    view.kind === 'app'
      ? htmlPage({ ...meta, islands, share: { defaultMode, readerChrome: false } }, body)
      : htmlPage(
          { ...meta, islands, share: shareMeta },
          shareShell(body, { neat: neatBackground !== null }),
        ),
  );
}

export function mountShare(app: Hono): void {
  app.get('/s/:token', renderShare);
}
