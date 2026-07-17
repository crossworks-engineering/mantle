'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiSend } from '@/lib/api-fetch';

/** Probe result from a successful `intent: 'test'` (saves navigate instead). */
type TestOk = { ok: true; foldersFound: number; folderSample: string[]; serverName?: string };

/** Existing account passed in for edit mode (never includes the password). */
export type ImapFormAccount = {
  id: string;
  address: string;
  displayName: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  firstScanDays: number;
};

/**
 * Add OR edit an IMAP account. In edit mode the address is fixed (it's the
 * account identity / encryption AAD) and the password field is optional —
 * blank keeps the stored one.
 *
 * React 19 resets uncontrolled inputs after every server action submission,
 * which would blow away everything you just typed when you hit "Test".
 * Keeping inputs controlled in component state side-steps that — typed
 * values survive across test → fix → save cycles.
 */
export function ImapForm({ account }: { account?: ImapFormAccount }) {
  const isEdit = !!account;
  const router = useRouter();
  const queryClient = useQueryClient();

  const [address, setAddress] = useState(account?.address ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [host, setHost] = useState(account?.imapHost ?? '');
  const [port, setPort] = useState(account?.imapPort ?? 993);
  const [secure, setSecure] = useState(account?.imapSecure ?? true);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [smtpHost, setSmtpHost] = useState(account?.smtpHost ?? '');
  const [smtpPort, setSmtpPort] = useState<number | ''>(account?.smtpPort ?? '');
  const [smtpSecure, setSmtpSecure] = useState(account?.smtpSecure ?? true);
  const [firstScanDays, setFirstScanDays] = useState(account?.firstScanDays ?? 365);

  const submit = useMutation({
    mutationFn: ({ intent }: { intent: 'test' | 'save' }) => {
      const body = {
        intent,
        // Edit uses the stored address (the encryption AAD); add sends it.
        ...(isEdit ? {} : { address }),
        displayName: displayName || undefined,
        host,
        port,
        secure,
        // Blank = keep the stored password (edit) / required (add, enforced by the input).
        password: password || undefined,
        firstScanDays,
        smtpHost: smtpHost || undefined,
        smtpPort: smtpPort === '' ? undefined : smtpPort,
        smtpSecure,
      };
      return isEdit
        ? apiSend<TestOk>(`/api/email/accounts/${account.id}`, 'PATCH', body)
        : apiSend<TestOk>('/api/email/accounts', 'POST', body);
    },
    onSuccess: (_res, { intent }) => {
      if (intent === 'save') {
        void queryClient.invalidateQueries({ queryKey: ['email', 'accounts'] });
        // Land on the plain list (mirrors the old action's redirect).
        router.push('/settings/accounts');
      }
    },
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value === 'test' ? 'test' : 'save';
    submit.mutate({ intent });
  };

  const pending = submit.isPending;
  const lastIntent = submit.variables?.intent;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {isEdit && <input type="hidden" name="accountId" value={account.id} />}
      <div className="space-y-2">
        <Label htmlFor="address">Email address</Label>
        <Input
          id="address"
          name="address"
          type="email"
          placeholder="you@yourdomain.com"
          required={!isEdit}
          disabled={isEdit}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        {isEdit && (
          <p className="text-xs text-muted-foreground">
            The address can&apos;t be changed. Remove the account and add it again to use a
            different one.
          </p>
        )}
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
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            required={!isEdit}
            autoComplete="off"
            placeholder={isEdit ? 'Leave blank to keep current password' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {isEdit
            ? 'Only enter a password if you want to replace the stored one.'
            : 'Use a provider-issued app password (Fastmail, iCloud, Gmail-as-IMAP). Mantle encrypts this at rest with your master key before storing it.'}
        </p>
      </div>
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Sending (SMTP) — optional</p>
          <p className="text-xs text-muted-foreground">
            Lets the assistant send email from this address. Uses the same app password. Leave blank
            to keep the account receive-only.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-2">
            <Label htmlFor="smtpHost">SMTP host</Label>
            <Input
              id="smtpHost"
              name="smtpHost"
              placeholder="smtp.fastmail.com"
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="smtpPort">Port</Label>
            <Input
              id="smtpPort"
              name="smtpPort"
              type="number"
              min={1}
              max={65535}
              placeholder="465"
              value={smtpPort}
              onChange={(e) =>
                setSmtpPort(e.target.value === '' ? '' : Number(e.target.value) || 0)
              }
            />
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm">
          <input
            id="smtpSecure"
            name="smtpSecure"
            type="checkbox"
            checked={smtpSecure}
            onChange={(e) => setSmtpSecure(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor="smtpSecure" className="cursor-pointer">
            Use TLS
          </Label>
          <span className="ml-auto text-xs text-muted-foreground">
            TLS on 465 · off for STARTTLS on 587
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="firstScanDays">Scan history (days)</Label>
        <Input
          id="firstScanDays"
          name="firstScanDays"
          type="number"
          min={1}
          max={3650}
          required
          value={firstScanDays}
          onChange={(e) => setFirstScanDays(Number(e.target.value) || 0)}
        />
        <p className="text-xs text-muted-foreground">
          How far back to scan headers on the first sync (e.g. 30 for the last month, 365 for a
          year).
          {isEdit
            ? ' Applies to folders not yet scanned — lowering it later won’t delete already-synced mail.'
            : ''}
        </p>
      </div>

      {/* Error from either intent. */}
      {!pending && submit.isError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <X className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">{lastIntent === 'test' ? 'Test failed' : 'Save failed'}</p>
            <p className="text-destructive/90">
              {submit.error instanceof Error ? submit.error.message : String(submit.error)}
            </p>
          </div>
        </div>
      )}
      {/* Successful probe (saves navigate away, so only `test` lands a panel). */}
      {!pending && submit.isSuccess && lastIntent === 'test' && submit.data && (
        <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Connected.</p>
            <p className="text-green-900/80 dark:text-green-100/80">
              Authenticated and found{' '}
              <span className="font-medium">{submit.data.foldersFound}</span> folder
              {submit.data.foldersFound === 1 ? '' : 's'}
              {submit.data.serverName ? (
                <>
                  {' '}
                  on <span className="font-medium">{submit.data.serverName}</span>
                </>
              ) : null}
              .
            </p>
            {submit.data.folderSample.length > 0 && (
              <p className="mt-1 truncate text-xs text-green-900/70 dark:text-green-100/70">
                e.g. {submit.data.folderSample.join(' · ')}
                {submit.data.foldersFound > submit.data.folderSample.length ? ' …' : ''}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" value="test" variant="outline" disabled={pending} className="flex-1">
          {pending && lastIntent === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        <SubmitButton pending={pending && lastIntent === 'save'} value="save" className="flex-1">
          {isEdit ? 'Save changes' : 'Connect & save'}
        </SubmitButton>
      </div>
    </form>
  );
}
