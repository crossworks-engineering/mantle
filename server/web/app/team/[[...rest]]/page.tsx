import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Team' };

/**
 * The member workspace moved to the CLIENT app with the split (the team
 * credential is bearer-shaped now — see lib/team-sso.ts for the way back).
 * This catch-all keeps every canonical-domain bookmark working — /team,
 * /team/forum/<id>, deep links with queries — by forwarding the full path to
 * the client origin. Members re-enter their 8-char token there once (the
 * cookie→bearer hop is deliberately manual: forwarding a credential through a
 * URL was rejected — fragments land in history and session stores).
 *
 * MANTLE_CLIENT_ORIGIN unset ⇒ no client app to forward to; render a static
 * pointer card instead of a loop or a 404.
 */
export default async function TeamMovedStub({
  params,
  searchParams,
}: {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const clientOrigin = (process.env.MANTLE_CLIENT_ORIGIN ?? '').replace(/\/+$/, '');
  if (clientOrigin) {
    const { rest } = await params;
    const sp = await searchParams;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (typeof v === 'string') qs.set(k, v);
      else for (const item of v ?? []) qs.append(k, item);
    }
    const suffix = rest?.length ? `/${rest.map(encodeURIComponent).join('/')}` : '';
    const query = qs.size ? `?${qs.toString()}` : '';
    redirect(`${clientOrigin}/team${suffix}${query}`);
  }
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-base font-semibold">The team workspace has moved</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This brain serves its member workspace from a separate app address. Ask the brain&rsquo;s
          admin for the current team link.
        </p>
      </div>
    </div>
  );
}
