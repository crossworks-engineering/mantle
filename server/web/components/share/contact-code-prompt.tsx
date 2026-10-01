'use client';

/**
 * The code prompt of a CONTACT share (contact shares, migration 0214):
 * renders instead of the item when the visitor holds no cookie that admits
 * the share's contact. It names neither the item nor the contact. A good
 * code (POST /s/<token>/code) sets the visitor cookie for every /s/ link,
 * and a reload shows the item.
 *
 * Public surface, no app shell and no toast provider, so feedback is
 * inline. Raw fetch on purpose: apiFetch is the app shell's wrapper.
 */
import { useState, useTransition } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@mantle/share-ui/ui/button';
import { Input } from '@mantle/share-ui/ui/input';
import { Label } from '@mantle/share-ui/ui/label';

export function ContactCodePrompt({ shareToken }: { shareToken: string }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    const value = code.replace(/\s+/g, '');
    if (!value) return;
    setError(null);
    start(async () => {
      try {
        const r = await fetch(`/s/${encodeURIComponent(shareToken)}/code`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: value }),
        });
        if (r.ok) {
          window.location.reload();
          return;
        }
        setError(
          r.status === 429
            ? 'Too many tries. Wait a minute and try again.'
            : 'That code was not recognised. Check it with the person who shared this.',
        );
      } catch {
        setError('Could not reach the server. Try again.');
      }
    });
  };

  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-6">
        <div className="space-y-1.5 text-center">
          <KeyRound className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <h1 className="text-lg font-semibold text-card-foreground">Enter your code</h1>
          <p className="text-sm text-muted-foreground">
            This link is shared with one person. Enter the code you were sent to open it.
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
            <Label htmlFor="contact-code">Code</Label>
            <Input
              id="contact-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              maxLength={64}
              className="text-center font-mono tracking-widest"
              aria-invalid={!!error}
            />
            {error && <p className="text-xs text-destructive-ink">{error}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={pending || !code.trim()}>
            {pending ? 'Checking…' : 'Continue'}
          </Button>
        </form>
      </div>
    </div>
  );
}
