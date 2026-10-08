import type { Context, Hono } from 'hono';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONTACT_MENU_LIMIT,
  isRetiredClientLinkToken,
  isRetiredTeamLinkToken,
  listContactShares,
  loadProfilePreferences,
  recordShareAccess,
} from '@mantle/content';
import { loadShareAppearance } from './appearance';
import { recordShareView, loadShareView } from '@/lib/shares';
import { gateShareCookie } from '@/lib/contact-share-gate';
import { ContactSharesMenu } from '@/components/share/contact-shares-menu';
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
 * Old client links were retired in client logins C3 (migration 0192): one
 * answers "sign in as a client", pointing at /client-signin.
 *
 * A CONTACT share (migration 0214) runs behind the contact gate: without a
 * cookie that admits the share's contact, the page is the code prompt (401,
 * no item title, no contact name, no menu). With one, the item renders with
 * the "Shared with you" menu of that contact's live shares.
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

/** The page an old client link shows (410, client logins C3): clients sign
 *  in now, and the item, if it is still at client, is in "Shared with you".
 *  No item title: the token says nothing about what it named. */
function retiredClientLinkPage(): string {
  const heading = 'Sign in as a client';
  const body =
    'This link no longer opens the item. Clients of this brain sign in and find ' +
    'what is shared with them there. No sign-in yet? Ask the brain admin.';
  return htmlPage(
    { title: heading, noindex: true },
    `<div class="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
<div class="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
<h1 class="text-base font-semibold">${escapeHtml(heading)}</h1>
<p class="mt-2 text-sm text-muted-foreground">${escapeHtml(body)}</p>
<p class="mt-4"><a href="/client-signin" class="text-sm font-medium text-primary underline underline-offset-4">Sign in</a></p>
</div>
</div>`,
  );
}

/** The code prompt of a contact share (401): an island, nothing about the
 *  item or the contact. The owner's appearance only. */
async function contactCodePage(ownerId: string, token: string): Promise<string> {
  const { attrs: appearance, defaultMode } = await loadShareAppearance(ownerId);
  return htmlPage(
    {
      title: 'Shared',
      noindex: true,
      og: { title: 'Shared', description: 'Shared via Mantle' },
      appearance,
      islands: true,
      share: { defaultMode, readerChrome: false },
    },
    `${islandDiv('contact-code', { shareToken: token }, 'h-dvh bg-background text-foreground')}
<noscript><p class="p-6 text-center text-sm">Turn on JavaScript to enter your code.</p></noscript>`,
  );
}

/** The brain's site name for the contact menu strip (null on a read error). */
async function siteNameOf(ownerId: string): Promise<string | null> {
  try {
    return (await loadProfilePreferences(ownerId)).siteName ?? null;
  } catch {
    return null;
  }
}

async function renderShare(c: Context): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const url = new URL(c.req.url);
  const p = url.searchParams.get('p') ?? '';

  // Invalid / revoked / expired all 404 — never reveal that a token existed.
  // The exceptions are retired team and client links: their visitors were
  // members or clients, and are told where to go now (no item title).
  const gate = await gateShareCookie(c.req.raw.headers.get('cookie'), token);
  if (gate.kind === 'missing') {
    if (await isRetiredTeamLinkToken(token)) return c.html(retiredTeamLinkPage(), 410);
    if (await isRetiredClientLinkToken(token)) return c.html(retiredClientLinkPage(), 410);
    return c.notFound();
  }
  if (gate.kind === 'code') {
    c.header('cache-control', 'no-store');
    return c.html(await contactCodePage(gate.share.ownerId, token), 401);
  }
  const { share, contact } = gate;
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

  // A contact share: its contact's other live shares, one bounded read, for
  // the contact named by THIS share (never one taken from the request).
  let menu = '';
  if (contact) {
    recordShareAccess({
      ownerId: share.ownerId,
      shareId: share.id,
      contactId: contact.contactId,
      kind: 'open',
    });
    const [listed, siteName] = await Promise.all([
      listContactShares(share.ownerId, contact.contactId, { limit: CONTACT_MENU_LIMIT }),
      siteNameOf(share.ownerId),
    ]);
    menu = renderToStaticMarkup(
      <ContactSharesMenu
        items={listed.items}
        more={listed.more}
        currentToken={token}
        siteName={siteName}
        shape={view.kind === 'app' ? 'pill' : 'strip'}
      />,
    );
    c.header('cache-control', 'no-store');
  }

  // Encoded, as drawUrl is: a note's `media:` id is free text from its
  // markdown, and a `/` or `?` in it must not reshape the path.
  const assetUrl = (fileId: string) => `/s/${token}/a/${encodeURIComponent(fileId)}`;
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
      // A note's `media:` and `draw:` pictures and file links resolve through
      // the share's own routes; isAssetAllowed / isEmbeddedDrawAllowed serve
      // only what the note's markdown embeds.
      body = renderToStaticMarkup(
        <NotePresenter view={view} assetUrl={assetUrl} drawUrl={drawUrl} />,
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
      ? htmlPage({ ...meta, islands, share: { defaultMode, readerChrome: false } }, body + menu)
      : htmlPage(
          { ...meta, islands, share: shareMeta },
          shareShell(menu + body, { neat: neatBackground !== null }),
        ),
  );
}

export function mountShare(app: Hono): void {
  app.get('/s/:token', renderShare);
}
