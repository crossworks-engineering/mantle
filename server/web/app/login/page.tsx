import { redirect } from 'next/navigation';

/**
 * Owner login moved to the CLIENT app with the split — this stub keeps the
 * canonical domain's stale bookmarks and the middleware's unauthenticated
 * 307→/login chain working by forwarding to the client origin.
 *
 * MANTLE_CLIENT_ORIGIN unset (single-host/monolith-style deployment where the
 * client app is served elsewhere behind the same host, or a headless box with
 * no owner UI at all) ⇒ a minimal explanation page would be nicer, but a
 * redirect loop is worse — so we just fall back to the team surface, which is
 * this origin's only interactive login-like entry.
 */
export default async function LoginStub({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const clientOrigin = (process.env.MANTLE_CLIENT_ORIGIN ?? '').replace(/\/+$/, '');
  if (clientOrigin) {
    const next = sp.next ? `?next=${encodeURIComponent(sp.next)}` : '';
    redirect(`${clientOrigin}/login${next}`);
  }
  redirect('/team');
}
