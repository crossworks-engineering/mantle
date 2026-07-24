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
    if (tokenStore.get()) router.replace(params.next ?? '/');
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
          <h1 className="font-logo text-5xl leading-none text-primary">mantle</h1>
          <p className="text-sm text-muted-foreground">
            {firstRun ? 'Create your account to begin.' : 'Sign in to your tree.'}
          </p>
        </div>
        <LoginForm mode={firstRun ? 'signup' : 'login'} next={params.next} error={params.error} />
      </div>
    </main>
  );
}
