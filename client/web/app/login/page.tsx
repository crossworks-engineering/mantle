'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { tokenStore } from '@mantle/web-ui/token-store';
import { LoginForm } from './login-form';

/**
 * Owner sign-in screen, zero-secret flavor: no server session read (this app
 * can't verify one). Already-holding-a-bearer visitors bounce straight in;
 * fresh installs (GET /api/auth/bootstrap-state — public, boolean-only) get
 * the create-account variant, exactly like the monolith's first-run gate.
 */
export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = use(searchParams);
  const router = useRouter();

  useEffect(() => {
    if (tokenStore.get()) {
      // Re-assert the presence cookie before bouncing. It can be lost while
      // the token survives (an abrupt shutdown can drop Chromium's unflushed
      // cookie store; localStorage flushes eagerly) — and without it the
      // middleware redirects the bounce right back here, a deadlock.
      tokenStore.markPresence();
      router.replace(params.next ?? '/');
    }
  }, [router, params.next]);

  const bootQuery = useQuery({
    queryKey: ['auth-bootstrap-state'],
    queryFn: () => apiFetch<{ firstRun: boolean }>('/api/auth/bootstrap-state'),
  });
  const firstRun = bootQuery.data?.firstRun ?? false;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
          {/* The STACKED lockup — badge over wordmark — and the only surface
              that gets the full mark; everywhere in-app wears the row lockup or
              the wordmark alone, so the bird stays an event rather than chrome.
              Two imgs swapped by the `dark:` variant: a CSS swap, so flipping
              the theme never waits on a fetch. */}
          <h1>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/jackdaw-lockup-light.png"
              alt="Jackdaw"
              width={145}
              height={180}
              className="mx-auto h-[180px] w-auto dark:hidden"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/jackdaw-lockup-dark.png"
              alt="Jackdaw"
              width={144}
              height={180}
              className="mx-auto hidden h-[180px] w-auto dark:block"
            />
          </h1>
          <p className="text-sm text-muted-foreground">
            {firstRun ? 'Create your login to begin.' : 'Sign in to your tree.'}
          </p>
        </div>
        <LoginForm mode={firstRun ? 'signup' : 'login'} next={params.next} error={params.error} />
      </div>
    </main>
  );
}
