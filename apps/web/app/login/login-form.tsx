'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabaseBrowser } from '@/lib/supabase/client';

export function LoginForm({ next, error: initialError }: { next?: string; error?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(initialError);
  const [busy, setBusy] = useState(false);

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const sb = supabaseBrowser();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(next ?? '/');
    router.refresh();
  }

  async function signInWithGoogle() {
    const sb = supabaseBrowser();
    await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next ?? '/')}`,
      },
    });
  }

  return (
    <form onSubmit={signInWithPassword} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
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
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="relative my-2 flex items-center">
        <span className="flex-1 border-t border-border" />
        <span className="px-2 text-xs uppercase text-muted-foreground">or</span>
        <span className="flex-1 border-t border-border" />
      </div>
      <Button type="button" variant="outline" className="w-full" onClick={signInWithGoogle}>
        Continue with Google
      </Button>
      <p className="pt-2 text-center text-xs text-muted-foreground">
        First time?{' '}
        <a href={`/setup${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="underline">
          Create your Mantle
        </a>
      </p>
    </form>
  );
}
