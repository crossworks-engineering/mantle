'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { apiUrl } from '@mantle/web-ui/api-fetch';
import { runtimeApiBase } from '@mantle/web-ui/runtime-env';
import { tokenStore } from '@mantle/web-ui/token-store';

/**
 * Owner sign-in, both topologies:
 *
 *   same-origin (runtime apiBase empty — single-host deploys, local dev):
 *     cookie login exactly as the monolith (POST /api/auth/login with
 *     credentials) + the presence cookie for the client middleware.
 *
 *   split (apiBase set): POST /api/auth/token — the response bearer goes to
 *     the token store (which also sets the presence cookie); no cross-origin
 *     cookies anywhere.
 *
 * Signup (first-run) creates the account first, then enters the same branch —
 * in split mode that means an immediate token exchange with the same
 * credentials.
 */
export function LoginForm({
  mode = 'login',
  next,
  error: initialError,
}: {
  mode?: 'login' | 'signup';
  next?: string;
  error?: string;
}) {
  const router = useRouter();
  const isSignup = mode === 'signup';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(initialError);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const split = runtimeApiBase() !== '';

      if (isSignup) {
        const res = await fetch(apiUrl('/api/auth/signup'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
          credentials: split ? 'omit' : 'include',
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? 'Could not create your account.');
          return;
        }
      }

      if (split) {
        const res = await fetch(apiUrl('/api/auth/token'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, deviceName: 'Web client' }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? 'Sign-in failed.');
          return;
        }
        const { token } = (await res.json()) as { token: string };
        tokenStore.set(token);
      } else if (!isSignup) {
        const res = await fetch(apiUrl('/api/auth/login'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
          credentials: 'include',
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? 'Sign-in failed.');
          return;
        }
        tokenStore.markPresence();
      } else {
        // same-origin signup already set the session cookie above.
        tokenStore.markPresence();
      }

      // New accounts go straight into onboarding; returning users to where
      // they were headed (AppShell redirects to /onboarding if not yet done).
      router.push(isSignup ? '/onboarding' : (next ?? '/'));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <SubmitButton pending={busy} className="w-full">
        {isSignup ? 'Create account' : 'Sign in'}
      </SubmitButton>
    </form>
  );
}
