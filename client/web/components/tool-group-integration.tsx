'use client';

/**
 * The Integration section of a tool-group editor — everything that makes a
 * group an API integration rather than a plain capability bundle: the service,
 * its base URL, which vault entry authenticates it, WHERE that credential goes,
 * and the two artefacts that travel with the grant (the stored API docs and the
 * usage skill).
 *
 * Everything Toolsmith can set, the owner can correct here. The credential
 * itself is never handled: the ref picker lists `service/label` pointers from
 * the vault (masked previews only) and writes `{{secret:…}}` into the auth
 * template, which the dispatcher resolves at call time.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import type { ToolGroupIntegrationDTO } from '@mantle/client-types';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Textarea } from '@mantle/web-ui/ui/textarea';
import { useToast } from '@mantle/web-ui/ui/toast';

/** One auth-template entry, flattened for editing. */
export type AuthRow = { id: string; kind: 'header' | 'query'; name: string; value: string };

/** The editable projection of `integration` used by the group form. */
export type IntegrationForm = {
  enabled: boolean;
  service: string;
  baseUrl: string;
  secretRef: string;
  auth: AuthRow[];
  /** Read-only pointers — set by Toolsmith, shown so the owner can follow them. */
  docsNodeId: string | null;
  docsSourceUrl: string | null;
  docsUpdatedAt: string | null;
  skillSlug: string | null;
};

let rowSeq = 0;
const nextRowId = (): string => `auth_${++rowSeq}`;

export function emptyIntegrationForm(): IntegrationForm {
  return {
    enabled: false,
    service: '',
    baseUrl: '',
    secretRef: '',
    auth: [],
    docsNodeId: null,
    docsSourceUrl: null,
    docsUpdatedAt: null,
    skillSlug: null,
  };
}

export function integrationFormFrom(meta: ToolGroupIntegrationDTO | null): IntegrationForm {
  if (!meta) return emptyIntegrationForm();
  const auth: AuthRow[] = [];
  for (const [name, value] of Object.entries(meta.authTemplate?.headers ?? {})) {
    auth.push({ id: nextRowId(), kind: 'header', name, value });
  }
  for (const [name, value] of Object.entries(meta.authTemplate?.query ?? {})) {
    auth.push({ id: nextRowId(), kind: 'query', name, value });
  }
  return {
    enabled: true,
    service: meta.service,
    baseUrl: meta.baseUrl ?? '',
    secretRef: meta.secretRef ?? '',
    auth,
    docsNodeId: meta.docsNodeId ?? null,
    docsSourceUrl: meta.docsSourceUrl ?? null,
    docsUpdatedAt: meta.docsUpdatedAt ?? null,
    skillSlug: meta.skillSlug ?? null,
  };
}

/** Form → the wire shape. `null` means "not an integration" (clears the binding). */
export function integrationToPayload(
  form: IntegrationForm,
): Record<string, unknown> | null | undefined {
  if (!form.enabled) return null;
  if (!form.service.trim()) return undefined; // caller blocks the save
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const row of form.auth) {
    if (!row.name.trim()) continue;
    (row.kind === 'header' ? headers : query)[row.name.trim()] = row.value;
  }
  const authTemplate: Record<string, unknown> = {};
  if (Object.keys(headers).length > 0) authTemplate.headers = headers;
  if (Object.keys(query).length > 0) authTemplate.query = query;
  return {
    service: form.service.trim(),
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
    ...(form.secretRef.trim() ? { secretRef: form.secretRef.trim() } : {}),
    ...(Object.keys(authTemplate).length > 0 ? { authTemplate } : {}),
    ...(form.docsNodeId ? { docsNodeId: form.docsNodeId } : {}),
    ...(form.docsSourceUrl ? { docsSourceUrl: form.docsSourceUrl } : {}),
    ...(form.docsUpdatedAt ? { docsUpdatedAt: form.docsUpdatedAt } : {}),
    ...(form.skillSlug ? { skillSlug: form.skillSlug } : {}),
  };
}

type KeyRow = { service: string; label: string; masked: string };

export function ToolGroupIntegrationSection({
  value,
  onChange,
}: {
  value: IntegrationForm;
  onChange: (next: IntegrationForm) => void;
}) {
  const keysQuery = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiFetch<{ keys: KeyRow[] }>('/api/keys').then((r) => r.keys),
  });
  const refs = (keysQuery.data ?? []).map((k) => ({
    ref: `${k.service}/${k.label}`,
    masked: k.masked,
  }));
  const [docsOpen, setDocsOpen] = useState(false);

  const patch = (p: Partial<IntegrationForm>) => onChange({ ...value, ...p });
  const setRow = (id: string, p: Partial<AuthRow>) =>
    patch({ auth: value.auth.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Integration</h3>
          <p className="text-xs text-muted-foreground">
            Bind this group to one external API. Tools authored into it inherit the base URL and
            credential — and its stored docs and usage skill travel with the grant.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
          <Switch
            checked={value.enabled}
            onCheckedChange={(v) => patch({ enabled: v })}
            aria-label="This group is an API integration"
          />
          API integration
        </label>
      </div>

      {value.enabled && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="integration-service">Service</Label>
              <Input
                id="integration-service"
                value={value.service}
                onChange={(e) => patch({ service: e.target.value })}
                placeholder="openweathermap"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="integration-base-url">Base URL</Label>
              <Input
                id="integration-base-url"
                value={value.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                placeholder="https://api.openweathermap.org/data/2.5"
                className="font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="integration-secret-ref">Credential</Label>
            <Select
              value={value.secretRef || 'none'}
              onValueChange={(v) => patch({ secretRef: v === 'none' ? '' : v })}
            >
              <SelectTrigger id="integration-secret-ref">
                <SelectValue placeholder="No credential bound" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No credential bound</SelectItem>
                {refs.map((r) => (
                  <SelectItem key={r.ref} value={r.ref} className="font-mono">
                    {r.ref} · {r.masked}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              From the encrypted vault —{' '}
              <Link href="/settings/keys" className="underline underline-offset-2">
                Settings → API keys
              </Link>{' '}
              is where keys are added. Only the <code className="font-mono">service/label</code>{' '}
              pointer is stored here; the key itself is decrypted inside the dispatcher.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Where the credential goes</Label>
            {value.auth.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing set — tools authored into this group will inherit no credential.
              </p>
            )}
            {value.auth.map((row) => (
              <div key={row.id} className="flex items-center gap-1.5">
                <Select
                  value={row.kind}
                  onValueChange={(v) => setRow(row.id, { kind: v as AuthRow['kind'] })}
                >
                  <SelectTrigger className="h-9 w-28 shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="header">header</SelectItem>
                    <SelectItem value="query">query</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={row.name}
                  onChange={(e) => setRow(row.id, { name: e.target.value })}
                  placeholder={row.kind === 'header' ? 'Authorization' : 'appid'}
                  className="h-9 w-40 shrink-0 font-mono text-xs"
                />
                <Input
                  value={row.value}
                  onChange={(e) => setRow(row.id, { value: e.target.value })}
                  placeholder="{{secret:service/label}}"
                  className="h-9 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground"
                  title="Remove"
                  onClick={() => patch({ auth: value.auth.filter((r) => r.id !== row.id) })}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  patch({
                    auth: [
                      ...value.auth,
                      {
                        id: nextRowId(),
                        kind: 'header',
                        name: 'Authorization',
                        value: value.secretRef ? `Bearer {{secret:${value.secretRef}}}` : '',
                      },
                    ],
                  })
                }
              >
                <Plus /> Auth header
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  patch({
                    auth: [
                      ...value.auth,
                      {
                        id: nextRowId(),
                        kind: 'query',
                        name: 'api_key',
                        value: value.secretRef ? `{{secret:${value.secretRef}}}` : '',
                      },
                    ],
                  })
                }
              >
                <Plus /> Auth query param
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Merged UNDER each authored tool&apos;s own headers/query — a tool that sets the same
              key keeps its own value. Write the credential as{' '}
              <code className="font-mono">{'{{secret:service/label}}'}</code>, never the key itself.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>API documentation</Label>
              {value.docsNodeId ? (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    Stored{value.docsUpdatedAt ? ` ${value.docsUpdatedAt.slice(0, 10)}` : ''}
                    {value.docsSourceUrl ? ' from ' : ''}
                    {value.docsSourceUrl && (
                      <a
                        href={value.docsSourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline underline-offset-2"
                      >
                        the source
                      </a>
                    )}
                    .
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDocsOpen(true)}
                    >
                      View / replace
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <Link href="/files?path=files.api_docs">
                        Open in Files <ExternalLink />
                      </Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  None stored. Toolsmith writes it when it builds the integration, so a later pass
                  reads the captured copy instead of re-fetching the vendor&apos;s site.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Usage skill</Label>
              {value.skillSlug ? (
                <p className="text-xs text-muted-foreground">
                  <Link
                    href={`/settings/skills?selected=${encodeURIComponent(value.skillSlug)}`}
                    className="font-mono underline underline-offset-2"
                  >
                    {value.skillSlug}
                  </Link>{' '}
                  — every agent granted this group carries it in context, so keep it short.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  None. Toolsmith distils one from the docs after the calls test green.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {value.docsNodeId && (
        <DocsDialog
          open={docsOpen}
          onOpenChange={setDocsOpen}
          nodeId={value.docsNodeId}
          service={value.service}
        />
      )}
    </div>
  );
}

/** View + replace the stored docs markdown. The file is a normal file node, so
 *  this is the same read/write path the Files editor uses (and re-indexes). */
function DocsDialog({
  open,
  onOpenChange,
  nodeId,
  service,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId: string;
  service: string;
}) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const fileQuery = useQuery({
    queryKey: ['api-docs-file', nodeId],
    enabled: open,
    queryFn: () =>
      apiFetch<{ file: { filename: string }; content?: string }>(`/api/files/files/${nodeId}`),
  });
  const loaded = text ?? fileQuery.data?.content ?? '';
  const save = useMutation({
    mutationFn: (content: string) => apiSend(`/api/files/files/${nodeId}`, 'PATCH', { content }),
    onSuccess: () => {
      toast.success('Documentation saved');
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed.'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setText(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{service || 'Integration'} documentation</DialogTitle>
          <DialogDescription>
            The markdown agents read before adding a call. Editing it here replaces the stored file
            and re-indexes it for search.
          </DialogDescription>
        </DialogHeader>
        {fileQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(loaded);
            }}
            className="space-y-3"
          >
            <Textarea
              value={loaded}
              onChange={(e) => setText(e.target.value)}
              className="h-[50vh] font-mono text-xs"
            />
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton pending={save.isPending}>Save documentation</SubmitButton>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
