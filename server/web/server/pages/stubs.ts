import type { Context, Hono } from 'hono';
import { escapeHtml } from './template';
import { env } from '@mantle/config';

/**
 * Redirect stubs for the surfaces that moved to the CLIENT app with the split
 * (ports of the app/login page stub). They keep canonical-domain bookmarks and
 * the gate's unauthenticated 307→/login chain working by forwarding to
 * MANTLE_CLIENT_ORIGIN; with no client origin configured they fall back to a
 * static pointer card: an explanation, never a loop.
 *
 * /team and /hub (the team-code portal) were retired in member logins
 * Phase 6: see mountRetiredTeamPages.
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

/**
 * The retired team-code portal pages (member logins Phase 6): /team, anything
 * under it, and /hub. A team member signs in with a member login now (invites,
 * docs/member-logins.md section 9), so an old bookmark goes to /login.
 *
 * Mounted BEFORE the auth gate (server/app.ts), so it answers the same for
 * everyone: no `next=/team` (the page is gone) and no query carried over (an
 * old link may hold a team code). The paths are not in PUBLIC_PATHS; a
 * credentialed nav never reaches the gate for them either.
 */
export function mountRetiredTeamPages(app: Hono): void {
  const toLogin = (c: Context) => c.redirect('/login', 307);
  for (const path of ['/team', '/team/*', '/hub', '/hub/*']) app.get(path, toLogin);
}

export function mountStubs(app: Hono): void {
  app.get('/login', async (c) => {
    const origin = clientOrigin();
    const next = new URL(c.req.url).searchParams.get('next');
    if (origin) {
      return c.redirect(`${origin}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`, 307);
    }
    // No client origin: explain, never redirect (this stub used to send the
    // browser to /team, which now comes straight back here).
    const { htmlPage } = await import('./template');
    return c.html(
      htmlPage(
        { title: 'Sign in' },
        movedCard(
          'Sign in from the app',
          'This brain serves its sign-in page from a separate app address. Ask the brain&rsquo;s admin for the current link.',
        ),
      ),
    );
  });

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
