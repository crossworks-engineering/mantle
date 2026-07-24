import { redirect } from 'next/navigation';

/**
 * Owner login moved to the CLIENT app with the split — this stub keeps the
 * canonical domain's stale bookmarks and the middleware's unauthenticated
 * 307→/login chain working by forwarding to the client origin.
 *
 * MANTLE_CLIENT_ORIGIN unset (single-host/monolith-style deployment where the
 * client app is served elsewhere behind the same host, or a headless box with
 * no owner UI at all) ⇒ fall through to /team, whose own stub renders a
 * static "ask the admin for the link" card — an explanation, never a loop.
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
