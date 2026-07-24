'use client';

/**
 * "Save as agent tool" — converts the current http draft into a `tools`
 * row agents can call.
 *
 * Every `{param}` placeholder found in the URL, query values, headers, or
 * body template becomes a parameter in the tool's input schema (type +
 * description + required, editable here). `{{secret:…}}` vault refs are
 * preserved verbatim — they resolve inside the dispatcher at call time.
 * Environment `{{vars}}` are baked in at save time so the tool is
 * self-contained.
 *
 * Grant path after saving: add the slug to a tool group, grant the group
 * to an agent — heartbeat runs pick it up automatically.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@mantle/web-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
import { Checkbox } from '@mantle/web-ui/ui/checkbox';
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
import { useToast } from '@mantle/web-ui/ui/toast';
import { buildVarMap, substituteVars } from '@/lib/dev-tools/client';
import { apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { useDevTools } from './context';
import { slugify } from '@/lib/slugify';

const PARAM_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type ParamSpec = {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
};

export function SaveToolDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { draft, activeEnv, refreshAgentTools } = useDevTools();
  const toast = useToast();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [requiresConfirm, setRequiresConfirm] = useState(false);
  const [params, setParams] = useState<ParamSpec[]>([]);
  const [pending, setPending] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);

  // Bake env vars in; keep {param} and {{secret:…}} intact.
  const handler = useMemo(() => {
    const vars = buildVarMap(activeEnv);
    let url = substituteVars(draft.url, vars);
    if (!/^https?:\/\//i.test(url) && typeof window !== 'undefined') {
      url = window.location.origin + (url.startsWith('/') ? url : `/${url}`);
    }
    const query: Record<string, string> = {};
    for (const p of draft.params) {
      if (p.enabled && p.key.trim())
        query[substituteVars(p.key, vars)] = substituteVars(p.value, vars);
    }
    const headers: Record<string, string> = {};
    for (const h of draft.headers) {
      if (h.enabled && h.key.trim())
        headers[substituteVars(h.key, vars)] = substituteVars(h.value, vars);
    }
    // Mirror the run path: only add the bearer header if none is set manually,
    // so the saved tool can't carry both `authorization` and `Authorization`.
    if (
      draft.auth.mode === 'bearer' &&
      draft.auth.token &&
      !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
    ) {
      headers['Authorization'] = `Bearer ${substituteVars(draft.auth.token, vars)}`;
    }
    const body =
      draft.method !== 'GET' && draft.body.mode !== 'none' && draft.body.text.trim() !== ''
        ? substituteVars(draft.body.text, vars)
        : undefined;
    return {
      kind: 'http' as const,
      url,
      method: draft.method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  }, [draft, activeEnv]);

  const detectedParams = useMemo(() => {
    const haystack = [
      handler.url,
      ...Object.values(handler.query ?? {}),
      ...Object.values(handler.headers ?? {}),
      handler.body ?? '',
    ].join('\n');
    const names: string[] = [];
    for (const m of haystack.matchAll(PARAM_PATTERN)) {
      if (!names.includes(m[1]!)) names.push(m[1]!);
    }
    return names;
  }, [handler]);

  const targetsOwnApi =
    typeof window !== 'undefined' && handler.url.startsWith(window.location.origin + '/api/');

  // Flag credentials baked in as plaintext: a sensitive-keyed header/query whose
  // value isn't a `{{secret:…}}` vault ref gets written into the tool row as-is.
  const bakedCredentials = useMemo(() => {
    const sensitive = /(authorization|api[-_]?key|token|secret|password|cookie|bearer)/i;
    const hasVaultRef = /\{\{\s*secret:/i;
    const offenders: string[] = [];
    const check = (key: string, value: string) => {
      if (value && sensitive.test(key) && !hasVaultRef.test(value) && !offenders.includes(key)) {
        offenders.push(key);
      }
    };
    for (const [k, v] of Object.entries(handler.headers ?? {})) check(k, v);
    for (const [k, v] of Object.entries(handler.query ?? {})) check(k, v);
    return offenders;
  }, [handler]);

  // Re-seed form state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(draft.name === 'Untitled request' ? '' : draft.name);
    setSlug(
      slugify(draft.name === 'Untitled request' ? '' : draft.name, {
        allowUnderscore: true,
        separator: '_',
        maxLength: 64,
      }),
    );
    setSlugTouched(false);
    setDescription(draft.description ?? '');
    setRequiresConfirm(false);
    setSavedSlug(null);
    setParams(
      detectedParams.map((n) => ({ name: n, type: 'string', description: '', required: true })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of params) {
      properties[p.name] = {
        type: p.type,
        ...(p.description.trim() ? { description: p.description.trim() } : {}),
      };
      if (p.required) required.push(p.name);
    }
    setPending(true);
    try {
      await apiSend('/api/tools', 'POST', {
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim(),
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        handler,
        requiresConfirm,
        enabled: true,
      });
      toast.success(`Tool ${slug.trim()} created`);
      setSavedSlug(slug.trim());
      void refreshAgentTools();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Save as agent tool</DialogTitle>
          <DialogDescription>
            Placeholders like <code className="font-mono">{'{param}'}</code> become the tool&apos;s
            inputs — agents fill them when they call it.
          </DialogDescription>
        </DialogHeader>

        {savedSlug ? (
          <div className="space-y-3">
            <p className="text-sm">
              <code className="font-mono font-semibold">{savedSlug}</code> is registered. To put it
              in agents&apos; hands, add it to a tool group and grant that group to an agent —
              heartbeat runs pick it up automatically.
            </p>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/tool-groups">Open tool groups</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/agents">Open agents</Link>
              </Button>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tool-name">Name</Label>
                <Input
                  id="tool-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched)
                      setSlug(
                        slugify(e.target.value, {
                          allowUnderscore: true,
                          separator: '_',
                          maxLength: 64,
                        }),
                      );
                  }}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tool-slug">Slug (the function name the model calls)</Label>
                <Input
                  id="tool-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  pattern="[a-z0-9_\-]+"
                  className="font-mono"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-desc">Description (the model reads this)</Label>
              <Input
                id="tool-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it does, when an agent should use it"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Request</Label>
              <div className="space-y-1 rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs">
                <div className="break-all">
                  <span className="font-bold">{handler.method}</span> {handler.url}
                </div>
                {handler.query && (
                  <div className="text-muted-foreground">
                    query:{' '}
                    {Object.entries(handler.query)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' · ')}
                  </div>
                )}
                {handler.headers && (
                  <div className="text-muted-foreground">
                    headers: {Object.keys(handler.headers).join(', ')}
                  </div>
                )}
                {handler.body !== undefined && (
                  <div className="text-muted-foreground">+ body template</div>
                )}
              </div>
              {targetsOwnApi && (
                <p className="text-[11px] text-chart-3">
                  This targets Mantle&apos;s own API, which needs a browser session — agent calls
                  will be unauthenticated. For Mantle data, agents should use built-in tools
                  instead.
                </p>
              )}
              {bakedCredentials.length > 0 && (
                <p className="text-[11px] text-destructive">
                  {bakedCredentials.join(', ')} carr{bakedCredentials.length === 1 ? 'ies' : 'y'} a
                  literal credential that will be stored in the tool. Use{' '}
                  <code className="font-mono">{'{{secret:service/label}}'}</code> instead so the
                  plaintext stays in the vault (Settings → API keys).
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Inputs{params.length === 0 && ' — none detected'}</Label>
              {params.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Add <code className="font-mono">{'{param}'}</code> placeholders to the URL, query
                  values, headers, or body to give the tool inputs. Without them it always sends the
                  same request.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {params.map((p, i) => (
                    <div key={p.name} className="flex items-center gap-1.5">
                      <code className="w-28 shrink-0 truncate font-mono text-xs">{p.name}</code>
                      <Select
                        value={p.type}
                        onValueChange={(t) =>
                          setParams((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, type: t as ParamSpec['type'] } : x,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="h-8 w-24 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="string" className="text-xs">
                            string
                          </SelectItem>
                          <SelectItem value="number" className="text-xs">
                            number
                          </SelectItem>
                          <SelectItem value="boolean" className="text-xs">
                            boolean
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={p.description}
                        onChange={(e) =>
                          setParams((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, description: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="description for the model"
                        className="h-8 flex-1 text-xs"
                      />
                      <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Checkbox
                          checked={p.required}
                          onCheckedChange={(v) =>
                            setParams((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, required: v === true } : x)),
                            )
                          }
                        />
                        req
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch checked={requiresConfirm} onCheckedChange={setRequiresConfirm} />
              Requires operator confirm before agents can run it
            </label>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton pending={pending}>Create tool</SubmitButton>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
