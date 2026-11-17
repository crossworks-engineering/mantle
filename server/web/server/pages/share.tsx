import type { Context } from 'hono';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRetiredClientLinkToken, isRetiredTeamLinkToken } from '@mantle/content';
import { loadShareAppearance } from './appearance';
import { recordShareView, loadShareView, sharePresentsShown } from '@/lib/shares';
import { referencedPresentIds } from '@mantle/content';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { openShareLink } from '@/lib/share-gate';
import { PagePresenter } from '@/components/share/page-presenter';
import { NotePresenter } from '@mantle/share-ui/note-presenter';
import { FilePresenter } from '@mantle/share-ui/file-presenter';
import { TaskPresenter } from '@mantle/share-ui/task-presenter';
import { EventPresenter } from '@mantle/share-ui/event-presenter';
import { FolderPresenter, loadFolderListing } from '@/components/share/folder-presenter';
import { FormulaPresenter } from '@mantle/share-ui/formula-presenter';
import { DrawPresenter } from '@mantle/share-ui/draw-presenter';
import { shareCanvasApiBase } from '@mantle/share-ui/present-presenter';
import { escapeHtml, htmlPage, islandDiv, shareShell } from './template';
import type { PageRoute } from '../route-loader';
import { CACHE_CONTROL } from '../../lib/cache-control';
import { requestOrigin } from '../../lib/auth-constants';

/**
 * The public /s/[token] share surface — the port of app/s/[token]/page.tsx.
 * Static presenters (page/note/file/task/event/folder) render to HTML via
 * react-dom/server; the interactive ones (app, table, the formula calculator,
 * 'use client' under Next too) mount as client islands from
 * /share-runtime/islands.js. Always resolved per request against the live DB —
 * a revoked link must 404 immediately.
 *
 * Every link here is open: team links are retired (migration 0176 revoked
 * them). An old team link answers a plain "sign in as a member" page
 * instead of the not-found, pointing at /login. Client links are retired
 * too (migration 0192): one answers a plain 410 "this link has ended" (there
 * is no client sign-in page, so it points nowhere). Contact shares are
 * gone too (migration 0378 deleted them): their tokens answer the plain 404.
 */

const SHARE_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** The CSP of a shared canvas's page. Its frame may load the canvas frame
 *  document of THIS link only: a canvas may always navigate its own frame,
 *  and in a browser that ignores the iframe's `csp` attribute only this
 *  directive keeps it off every other URL, the brain's own included. No
 *  other site may frame the page (the canvas frame refuses such an ancestor
 *  anyway: this says so at the page). An origin or token of any other shape
 *  falls back to the whole origin, never to more. */
export function shareCanvasPageCsp(origin: string, token: string): string {
  const frame =
    SHARE_ORIGIN_RE.test(origin) && SHARE_TOKEN_RE.test(token)
      ? `${origin}${shareCanvasApiBase(token)}/frame`
      : "'self'";
  return `frame-src ${frame}; child-src ${frame}; frame-ancestors 'self'`;
}

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

/** The page an old client link shows (410; there are no client sign-in
 *  pages, so it links nowhere). No item title:
 *  the token says nothing about what it named. */
function retiredClientLinkPage(): string {
  const heading = 'This link has ended';
  const body = 'Ask the person who sent it for a new one.';
  return htmlPage(
    { title: heading, noindex: true },
    `<div class="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
<div class="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
<h1 class="text-base font-semibold">${escapeHtml(heading)}.</h1>
<p class="mt-2 text-sm text-muted-foreground">${escapeHtml(body)}</p>
</div>
</div>`,
  );
}

async function renderShare(c: Context): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const url = new URL(c.req.url);
  const p = url.searchParams.get('p') ?? '';

  // Invalid / revoked / expired all 404 — never reveal that a token existed.
  // The exceptions are retired team and client links: a team link's visitor
  // is told where to go now, a client link's that it has ended (no item
  // title either way).
  const share = await openShareLink(token);
  if (!share) {
    if (await isRetiredTeamLinkToken(token)) return c.html(retiredTeamLinkPage(), 410);
    if (await isRetiredClientLinkToken(token)) return c.html(retiredClientLinkPage(), 410);
    return c.notFound();
  }
  const view = await loadShareView(share);
  if (!view) return c.notFound();

  const heading = 'title' in view ? view.title : view.filename;
  // The owner's brand renders into the <html> tag — a share page is the
  // BRAIN's surface, so the owner's theme + fonts are the only appearance.
  // The owner also sets the DEFAULT mode and the Drift backdrop; the visitor's
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

  // One reader chrome for every shelled body.
  const shareMeta = {
    defaultMode,
    neat: neatBackground,
    readerChrome: true,
  };

  void recordShareView(share.id); // fire-and-forget view counter

  // Encoded, as drawUrl is: a note's `media:` id is free text from its
  // markdown, and a `/` or `?` in it must not reshape the path.
  const assetUrl = (fileId: string) => `/s/${token}/a/${encodeURIComponent(fileId)}`;
  const drawUrl = (drawId: string) => `/s/${token}/draw/${encodeURIComponent(drawId)}`;
  // An embedded canvas shows as its snapshot only where this link serves
  // it (isEmbeddedPresentAllowed); any other is a labelled placeholder, so
  // the page never asks for a picture the route would refuse.
  const embeddedCanvases =
    view.kind === 'page'
      ? referencedPresentIds(view.doc)
      : view.kind === 'note'
        ? referencedPresentIds(markdownToDoc(view.content))
        : [];
  const shownCanvases = embeddedCanvases.length
    ? await sharePresentsShown(share, embeddedCanvases)
    : new Set<string>();
  const presentUrl = (presentId: string) =>
    shownCanvases.has(presentId.toLowerCase())
      ? `/s/${token}/present/${encodeURIComponent(presentId)}`
      : null;

  let body: string | null;
  let islands = false;
  switch (view.kind) {
    case 'page':
      body = renderToStaticMarkup(
        <PagePresenter view={view} assetUrl={assetUrl} drawUrl={drawUrl} presentUrl={presentUrl} />,
      );
      break;
    case 'note':
      // A note's `media:` and `draw:` pictures and file links resolve through
      // the share's own routes; isAssetAllowed / isEmbeddedDrawAllowed serve
      // only what the note's markdown embeds.
      body = renderToStaticMarkup(
        <NotePresenter view={view} assetUrl={assetUrl} drawUrl={drawUrl} presentUrl={presentUrl} />,
      );
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
    case 'present':
      // Shell-less, as an app: the canvas takes the viewport, live in its
      // sandboxed frame (the island mints the ticket). Its source never
      // lands in this document.
      body = islandDiv('canvas', { view, token }, 'h-dvh bg-background text-foreground');
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

  // Apps and canvases skip the share shell: the presenter is h-dvh and the app owns the
  // whole viewport, so even the footer strip would sit below the fold as dead
  // scroll (it also gets mode stamping only — no toggle, no backdrop; the app
  // paints its own ground). Every other kind keeps the shell (scroll container
  // + footer) and the full reader chrome.
  // A canvas may navigate its own frame (a sandboxed frame always may), and
  // no frame CSP governs that: this page's frame-src does, so the frame
  // reaches only the brain (docs/proposals/canvas-files.md 5.3).
  if (view.kind === 'present') {
    c.header('Content-Security-Policy', shareCanvasPageCsp(requestOrigin(c.req.raw), token));
    // Built from the request's host: no cache may keep it for another.
    c.header('Cache-Control', CACHE_CONTROL.none);
  }
  const fullViewport = view.kind === 'app' || view.kind === 'present';
  return c.html(
    fullViewport
      ? htmlPage({ ...meta, islands, share: { defaultMode, readerChrome: false } }, body)
      : htmlPage(
          { ...meta, islands, share: shareMeta },
          shareShell(body, { neat: neatBackground !== null }),
        ),
  );
}

/**
 * The /s page, registered by the route loader with its ROUTE_POLICY rows
 * (class 'link', registerPages). The gate runs it through
 * enterCall as system(http:share-page) (the row's startsAs); the share gate
 * (openShareLink) names the link once it resolves it.
 * Registered after the manifest's routes.
 */
export const SHARE_PAGES: readonly PageRoute[] = [
  { pattern: '/s/:token', methods: ['GET'], handle: renderShare },
];
