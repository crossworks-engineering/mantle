'use client';

import { useActionState, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { handleImapForm, type ImapFormResult } from './actions';

const initial: ImapFormResult | undefined = undefined;

/**
 * React 19 resets uncontrolled inputs after every server action submission,
 * which would blow away everything you just typed when you hit "Test".
 * Keeping inputs controlled in component state side-steps that — typed
 * values survive across test → fix → save cycles.
 */
export function ImapForm() {
  const [state, formAction, pending] = useActionState(handleImapForm, initial);

  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(993);
  const [secure, setSecure] = useState(true);
  const [password, setPassword] = useState('');

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="address">Email address</Label>
        <Input
          id="address"
          name="address"
          type="email"
          placeholder="you@yourdomain.com"
          required
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="displayName">Display name (optional)</Label>
        <Input
          id="displayName"
          name="displayName"
          placeholder="Personal"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-2">
          <Label htmlFor="host">IMAP host</Label>
          <Input
            id="host"
            name="host"
            placeholder="imap.fastmail.com"
            required
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="port">Port</Label>
          <Input
            id="port"
            name="port"
            type="number"
            min={1}
            max={65535}
            required
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 0)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-input bg-muted/30 px-3 py-2 text-sm">
        <input
          id="secure"
          name="secure"
          type="checkbox"
          checked={secure}
          onChange={(e) => setSecure(e.target.checked)}
          className="h-4 w-4 rounded border-input"
        />
        <Label htmlFor="secure" className="cursor-pointer">
          Use TLS
        </Label>
        <span className="ml-auto text-xs text-muted-foreground">Recommended: TLS on port 993</span>
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">App password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Use a provider-issued app password (Fastmail, iCloud, Gmail-as-IMAP). Mantle encrypts this at rest
          with your master key before storing it.
        </p>
      </div>

      <ResultPanel state={state} pending={pending} />

      <div className="flex gap-2">
        <Button
          type="submit"
          name="intent"
          value="test"
          variant="outline"
          disabled={pending}
          className="flex-1"
        >
          {pending && state?.intent !== 'save' ? 'Testing…' : 'Test connection'}
        </Button>
        <Button type="submit" name="intent" value="save" disabled={pending} className="flex-1">
          {pending ? 'Saving…' : 'Connect & save'}
        </Button>
      </div>
    </form>
  );
}

function ResultPanel({ state, pending }: { state: ImapFormResult | undefined; pending: boolean }) {
  if (pending || !state) return null;
  if (state.ok === false) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <X className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{state.intent === 'test' ? 'Test failed' : 'Save failed'}</p>
          <p className="text-destructive/90">{state.error}</p>
        </div>
      </div>
    );
  }
  // Only `test` has an ok=true shape; saves redirect on success.
  return (
    <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
      <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">Connected.</p>
        <p className="text-green-900/80 dark:text-green-100/80">
          Authenticated and found <span className="font-medium">{state.foldersFound}</span> folder
          {state.foldersFound === 1 ? '' : 's'}
          {state.serverName ? (
            <>
              {' '}on <span className="font-medium">{state.serverName}</span>
            </>
          ) : null}
          .
        </p>
        {state.folderSample.length > 0 && (
          <p className="mt-1 truncate text-xs text-green-900/70 dark:text-green-100/70">
            e.g. {state.folderSample.join(' · ')}
            {state.foldersFound > state.folderSample.length ? ' …' : ''}
          </p>
        )}
      </div>
    </div>
  );
}
