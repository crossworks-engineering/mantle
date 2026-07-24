'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import type { MsConfigStatus } from '@mantle/microsoft';
import { apiSend } from '@mantle/web-ui/api-fetch';

/**
 * Azure AD app registration, editable from the UI (replaces editing `.env` +
 * restart). When the active config comes from environment variables, saving
 * here creates a per-owner override; "Reset to environment" removes it.
 *
 * Controlled inputs so the typed values survive a re-render. Persists via
 * PUT/DELETE /api/microsoft/config, then invalidates the parent's config query.
 */
export function MsConfigForm({
  status,
  suggestedRedirectUri,
}: {
  status: MsConfigStatus;
  suggestedRedirectUri: string;
}) {
  const queryClient = useQueryClient();
  const hasStoredSecret = status.source === 'db';

  const [clientId, setClientId] = useState(status.clientId ?? '');
  const [tenant, setTenant] = useState(status.tenant || 'common');
  const [redirectUri, setRedirectUri] = useState(status.redirectUri ?? suggestedRedirectUri);
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['microsoft', 'config'] });

  const save = useMutation({
    mutationFn: () =>
      apiSend('/api/microsoft/config', 'PUT', {
        clientId,
        clientSecret: secret || undefined,
        tenant: tenant || 'common',
        redirectUri,
      }),
    onSuccess: () => {
      setSaved(true);
      setSecret('');
      void invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const clear = useMutation({
    mutationFn: () => apiSend('/api/microsoft/config', 'DELETE'),
    onSuccess: () => {
      setSaved(false);
      void invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    save.mutate();
  };

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
          .{' '}
          {status.source === 'env'
            ? 'Currently loaded from environment variables — saving here overrides them.'
            : status.source === 'db'
              ? 'Set here in the UI.'
              : 'Not configured yet.'}
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="clientId">Application (client) ID</Label>
          <Input
            id="clientId"
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
              type={showSecret ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                hasStoredSecret
                  ? `Leave blank to keep current (${status.secretMasked})`
                  : 'Client secret value'
              }
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
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Add this <strong>exact</strong> URI to the app&apos;s Authentication → Web → Redirect
            URIs.
          </p>
        </div>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {saved && (
          <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
            Saved.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" pending={save.isPending}>
            Save Microsoft app
          </SubmitButton>
          {status.source === 'db' && (
            <Button
              type="button"
              onClick={() => {
                setError(null);
                clear.mutate();
              }}
              disabled={clear.isPending}
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
