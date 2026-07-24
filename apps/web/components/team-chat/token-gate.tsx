'use client';

/**
 * Token-entry gate for the /team member surface. A valid contact team token
 * sets the signed team-chat cookie (POST /api/team/auth); `onAuthed` lets the
 * caller refetch whatever it was rendering. Shared by the Team Hub landing and
 * the chat client — one gate, one cookie, both views.
 *
 * Public surface: raw fetch on purpose (apiFetch is the app shell's
 * authenticated wrapper), inline feedback (no toast provider).
 */
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';

export function TokenGate({
  onAuthed,
  heading = 'Team Chat',
}: {
  onAuthed: () => void;
  heading?: string;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const value = token.trim();
    if (!value || pending) return;
    setError(null);
    setPending(true);
    try {
      const r = await fetch('/api/team/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      if (r.ok) {
        onAuthed();
        return;
      }
      setError(
        r.status === 429
          ? 'Too many attempts — wait a minute and try again.'
          : 'That token wasn’t recognised. Check it with the brain’s admin.',
      );
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h1 className="text-base font-semibold">{heading}</h1>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Enter your team token to continue. Your conversations with the brain are visible to its
          admin.
        </p>
        <Label htmlFor="team-token" className="mb-1.5 block text-sm">
          Team token
        </Label>
        <Input
          id="team-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="e.g. Xk3mP2vQ"
          autoComplete="off"
          autoFocus
        />
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        <Button className="mt-4 w-full" onClick={submit} disabled={pending || !token.trim()}>
          {pending ? 'Checking…' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}
