'use client';

import { useActionState, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { MsConfigStatus } from '@mantle/microsoft';
import { clearMsConfig, saveMsConfig, type MsConfigResult } from './actions';

const initial: MsConfigResult | undefined = undefined;

/**
 * Azure AD app registration, editable from the UI (replaces editing `.env` +
 * restart). When the active config comes from environment variables, saving
 * here creates a per-owner override; "Reset to environment" removes it.
 *
 * Controlled inputs so React 19's post-action form reset doesn't wipe what was
 * typed (same reason as the IMAP form).
 */
export function MsConfigForm({
  status,
  suggestedRedirectUri,
}: {
  status: MsConfigStatus;
  suggestedRedirectUri: string;
}) {
  const [state, formAction] = useActionState(saveMsConfig, initial);
  const hasStoredSecret = status.source === 'db';

  const [clientId, setClientId] = useState(status.clientId ?? '');
  const [tenant, setTenant] = useState(status.tenant || 'common');
  const [redirectUri, setRedirectUri] = useState(status.redirectUri ?? suggestedRedirectUri);
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Microsoft app (Azure AD)</h3>
        <p className="text-xs text-muted-foreground">
          From your{' '}
          <a
            className="underline"
            href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
            target="_blank"
            rel="noreferrer"
          >
            app registration
          </a>
          . {status.source === 'env'
            ? 'Currently loaded from environment variables — saving here overrides them.'
            : status.source === 'db'
              ? 'Set here in the UI.'
              : 'Not configured yet.'}
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="clientId">Application (client) ID</Label>
          <Input
            id="clientId"
            name="clientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="clientSecret">Client secret</Label>
          <div className="relative">
            <Input
              id="clientSecret"
              name="clientSecret"
              type={showSecret ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={hasStoredSecret ? `Leave blank to keep current (${status.secretMasked})` : 'Client secret value'}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showSecret ? 'Hide secret' : 'Show secret'}
            >
              {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use the secret <em>value</em> (not the secret ID). Azure only shows it once.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenant">Directory (tenant)</Label>
          <Input
            id="tenant"
            name="tenant"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            placeholder="common"
          />
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">common</code> (any org + personal),{' '}
            <code className="font-mono">organizations</code>, or a specific tenant ID.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="redirectUri">Redirect URI</Label>
          <Input
            id="redirectUri"
            name="redirectUri"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Add this <strong>exact</strong> URI to the app&apos;s Authentication → Web → Redirect URIs.
          </p>
        </div>

        {state && !state.ok && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        )}
        {state?.ok && (
          <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
            Saved.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm">Save Microsoft app</SubmitButton>
          {status.source === 'db' && (
            <Button
              type="submit"
              formAction={clearMsConfig}
              formNoValidate
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
            >
              Reset to environment
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
