'use client';

/**
 * Token-entry gate for a TEAM-mode app share. Renders instead of the app when
 * the visitor has no live team session; a valid contact team token sets the
 * path-scoped visitor cookie (POST /s/<token>/auth) and a router.refresh()
 * re-runs the server page, which now sees the cookie and mounts the app.
 *
 * Public surface — no app shell, no toast provider — so feedback is inline.
 * Raw fetch on purpose: apiFetch is the app shell's authenticated wrapper.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function TeamTokenPrompt({ shareToken, title }: { shareToken: string; title: string }) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    const value = token.trim();
    if (!value) return;
    setError(null);
    start(async () => {
      try {
        const r = await fetch(`/s/${shareToken}/auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: value }),
        });
        if (r.ok) {
          router.refresh();
          return;
        }
        if (r.status === 429) {
          setError('Too many attempts — wait a minute and try again.');
        } else {
          setError('That token wasn’t recognised. Check it with whoever shared this app.');
        }
      } catch {
        setError('Could not reach the server — try again.');
      }
    });
  };

  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-6">
        <div className="space-y-1.5 text-center">
          <KeyRound className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <h1 className="text-lg font-semibold text-card-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">
            This app is shared with team members only. Enter your team token to continue.
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="team-token">Team token</Label>
            <Input
              id="team-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Xk3mP2vQ"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              className="text-center font-mono tracking-widest"
              aria-invalid={!!error}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={pending || !token.trim()}>
            {pending ? 'Checking…' : 'Open app'}
          </Button>
        </form>
      </div>
    </div>
  );
}
