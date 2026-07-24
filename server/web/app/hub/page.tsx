import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Team Hub' };

/**
 * The Team Hub moved to the CLIENT app with the split — same story as the
 * /team catch-all stub next door: forward canonical-domain bookmarks to the
 * client origin, static pointer card when no client origin is configured.
 */
export default function HubMovedStub() {
  const clientOrigin = (process.env.MANTLE_CLIENT_ORIGIN ?? '').replace(/\/+$/, '');
  if (clientOrigin) redirect(`${clientOrigin}/hub`);
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-base font-semibold">The team hub has moved</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This brain serves its team hub from a separate app address. Ask the brain&rsquo;s admin
          for the current link.
        </p>
      </div>
    </div>
  );
}
