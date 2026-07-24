'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';

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
    const res = await fetch(isSignup ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? (isSignup ? 'Could not create your account.' : 'Sign-in failed.'));
      return;
    }
    // New accounts go straight into onboarding; returning users to where they
    // were headed (the (app) shell sends them to /onboarding if not yet done).
    router.push(isSignup ? '/onboarding' : (next ?? '/'));
    router.refresh();
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
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {isSignup && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <SubmitButton pending={busy} className="w-full">
        {isSignup ? 'Create account' : 'Sign in'}
      </SubmitButton>
    </form>
  );
}
