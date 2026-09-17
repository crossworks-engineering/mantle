import type { Context, Hono } from 'hono';
import { escapeHtml } from './template';
import { env } from '@mantle/config';

/**
 * Redirect stubs for the surfaces that moved to the CLIENT app with the split
 * (ports of app/login, app/hub, app/team/[[...rest]] page stubs). They keep
 * canonical-domain bookmarks and the gate's unauthenticated 307→/login chain
 * working by forwarding to MANTLE_CLIENT_ORIGIN; with no client origin
 * configured they fall back to a static pointer card — an explanation, never
 * a loop.
 */

function clientOrigin(): string {
  return (env('MANTLE_CLIENT_ORIGIN') ?? '').replace(/\/+$/, '');
}

/** Both args are static literals today, but escape anyway so a future caller
 *  can't accidentally interpolate user input (audit hardening). `body` may
 *  carry entities (&rsquo;) — callers pass pre-escaped copy, nothing dynamic. */
function movedCard(heading: string, bodyHtml: string): string {
  return `<div class="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
<div class="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
<h1 class="text-base font-semibold">${escapeHtml(heading)}</h1>
<p class="mt-2 text-sm text-muted-foreground">${bodyHtml}</p>
</div>
</div>`;
}

export function mountStubs(app: Hono): void {
  app.get('/login', (c) => {
    const origin = clientOrigin();
    const next = new URL(c.req.url).searchParams.get('next');
    if (origin) {
      return c.redirect(`${origin}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`, 307);
    }
    return c.redirect('/team', 307);
  });

  app.get('/hub', async (c) => {
    const origin = clientOrigin();
    if (origin) return c.redirect(`${origin}/hub`, 307);
    const { htmlPage } = await import('./template');
    return c.html(
      htmlPage(
        { title: 'Team Hub' },
        movedCard(
          'The team hub has moved',
          'This brain serves its team hub from a separate app address. Ask the brain&rsquo;s admin for the current link.',
        ),
      ),
    );
  });

  // /team + /team/<anything> — forward the full path + query.
  const teamStub = async (c: Context) => {
    const origin = clientOrigin();
    const url = new URL(c.req.url);
    if (origin) {
      const suffix = url.pathname === '/team' ? '' : url.pathname.slice('/team'.length);
      return c.redirect(`${origin}/team${suffix}${url.search}`, 307);
    }
    const { htmlPage } = await import('./template');
    return c.html(
      htmlPage(
        { title: 'Team' },
        movedCard(
          'The team workspace has moved',
          'This brain serves its member workspace from a separate app address. Ask the brain&rsquo;s admin for the current team link.',
        ),
      ),
    );
  };
  app.get('/team', teamStub);
  app.get('/team/*', teamStub);

  // /n/<id> — the canonical node permalink, which lives in the CLIENT app.
  //
  // Unlike the stubs above this one is not merely a bookmark courtesy: nodeUrl()
  // mints `${publicBaseUrl()}/n/<id>` and publicBaseUrl() resolves to
  // MANTLE_PUBLIC_URL — the SERVER origin, because /s/<token> share links and
  // the Microsoft OAuth callback are served here. Every tool result hands the
  // assistant one of these links and the assistant writes them into content
  // that is STORED (chat replies, pages, forum answers, emails, and the `url`
  // on every /api/search hit the mobile companion offers as "Open in Mantle").
  // Nothing re-resolves them later, so without this stub a split deployment
  // bakes permanent 404s into the brain. Keeping the link canonical and
  // forwarding here is what makes it survive either topology.
  app.get('/n/*', async (c) => {
    const origin = clientOrigin();
    const url = new URL(c.req.url);
    if (origin) return c.redirect(`${origin}${url.pathname}${url.search}`, 307);
    const { htmlPage } = await import('./template');
    return c.html(
      htmlPage(
        { title: 'Item' },
        movedCard(
          'This item lives in the app',
          'This brain serves its workspace from a separate app address. Ask the brain&rsquo;s admin for the current link.',
        ),
      ),
    );
  });
}
