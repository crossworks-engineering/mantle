import type { Context, Hono } from 'hono';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadProfilePreferences, shareModeOf } from '@mantle/content';
import { DEFAULT_COLOR_THEME } from '@mantle/web-ui/lib/themes';
import { resolveActiveShareByToken, recordShareView, loadShareView } from '@/lib/shares';
import { resolveShareVisitor } from '@/lib/team-gate';
import { PagePresenter } from '@/components/share/page-presenter';
import { NotePresenter } from '@/components/share/note-presenter';
import { FilePresenter } from '@/components/share/file-presenter';
import { TaskPresenter } from '@/components/share/task-presenter';
import { EventPresenter } from '@/components/share/event-presenter';
import { FolderPresenter, loadFolderListing } from '@/components/share/folder-presenter';
import { htmlPage, islandDiv, scriptSafeJson, shareShell } from './template';

/**
 * The public /s/[token] share surface — the port of app/s/[token]/page.tsx.
 * Static presenters (page/note/file/task/event/folder) render to HTML via
 * react-dom/server; the interactive three (app, table, token prompt — 'use
 * client' under Next too) mount as client islands from
 * /share-runtime/islands.js. Always resolved per request against the live DB —
 * a revoked link must 404 immediately.
 */

/** The share OWNER's stored color theme, stamped before paint so shared
 *  pages/apps render in the brain's brand theme rather than the visitor
 *  default (was components/share/owner-color-theme.tsx). colorThemeOwner is
 *  the lock ColorThemeProvider checks on mount inside sandboxed apps. */
async function ownerThemeStamp(ownerId: string): Promise<string> {
  let theme: string | undefined;
  try {
    theme = (await loadProfilePreferences(ownerId)).colorTheme;
  } catch {
    // prefs unavailable — fall back to the default theme rather than failing
  }
  if (!theme || theme === DEFAULT_COLOR_THEME) return '';
  return `<script>(function(h){h.dataset.colorTheme=${scriptSafeJson(
    theme,
  )};h.dataset.colorThemeOwner='1';})(document.documentElement);</script>`;
}

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
  const extraHead = await ownerThemeStamp(share.ownerId);
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
    extraHead,
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

  let body: string | null;
  let islands = false;
  switch (view.kind) {
    case 'page':
      body = renderToStaticMarkup(<PagePresenter view={view} assetUrl={assetUrl} />);
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
