'use client';

/**
 * Request builder — middle panel of the API Console.
 *
 * http drafts get the full Postman treatment: method + URL bar, path-param
 * chips, Params/Headers/Body/Auth tabs, environment switcher, Save, and
 * "Save as agent tool". tool/mcp drafts get a schema-aware JSON args
 * editor and a Run button — the exact call an agent would make.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Save, Send, Settings2, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { buildVarMap, pathPlaceholders, substituteVars } from '@/lib/dev-tools/client';
import { genId } from '@/lib/dev-tools/storage';
import type { AuthMode, BodyMode, Environment, HttpMethod } from '@/lib/dev-tools/types';
import { useDevTools } from './context';
import { KvEditor } from './kv-editor';
import { KindBadge } from './method-badge';
import { SaveToolDialog } from './save-tool-dialog';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Available vault refs as copyable chips — discoverability for {{secret:…}}. */
function VaultRefChips() {
  const toast = useToast();
  const [keys, setKeys] = useState<Array<{ service: string; label: string }> | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch('/api/keys')
      .then((r) => r.json())
      .then((p: { keys?: Array<{ service: string; label: string }> }) => {
        if (alive) setKeys(p.keys ?? []);
      })
      .catch(() => {
        if (alive) setKeys([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!keys || keys.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      <KeyRound className="size-3 text-muted-foreground" />
      {keys.map((k) => {
        const ref = `{{secret:${k.service}/${k.label}}}`;
        return (
          <button
            key={ref}
            type="button"
            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="Copy vault reference"
            onClick={() =>
              void navigator.clipboard.writeText(ref).then(() => toast.success(`Copied ${ref}`))
            }
          >
            {ref}
          </button>
        );
      })}
    </div>
  );
}

function EnvironmentControls() {
  const { environments, setEnvironments, activeEnv, setActiveEnvId } = useDevTools();
  const [editing, setEditing] = useState(false);
  const [draftEnvs, setDraftEnvs] = useState<Environment[]>(environments);

  const openEditor = () => {
    setDraftEnvs(environments.map((e) => ({ ...e, vars: e.vars.map((v) => ({ ...v })) })));
    setEditing(true);
  };
  const save = () => {
    setEnvironments(draftEnvs.filter((e) => e.name.trim() !== ''));
    setEditing(false);
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <Select value={activeEnv?.id ?? ''} onValueChange={setActiveEnvId}>
          <SelectTrigger className="h-7 w-36 text-xs">
            <SelectValue placeholder="Environment" />
          </SelectTrigger>
          <SelectContent>
            {environments.map((e) => (
              <SelectItem key={e.id} value={e.id} className="text-xs">
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground"
          title="Edit environments"
          onClick={openEditor}
        >
          <Settings2 className="size-3.5" />
        </Button>
      </div>

      <Dialog open={editing} onOpenChange={(o) => !o && setEditing(false)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Environments</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {draftEnvs.map((env, i) => (
              <div key={env.id} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={env.name}
                    onChange={(e) =>
                      setDraftEnvs((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    placeholder="Name"
                    className="h-8 text-xs"
                  />
                  <Input
                    value={env.baseUrl}
                    onChange={(e) =>
                      setDraftEnvs((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)),
                      )
                    }
                    placeholder="Base URL (empty = this server)"
                    className="h-8 flex-[2] font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
                    title="Remove environment"
                    onClick={() => setDraftEnvs((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
                <KvEditor
                  entries={env.vars}
                  onChange={(vars) =>
                    setDraftEnvs((prev) => prev.map((x, j) => (j === i ? { ...x, vars } : x)))
                  }
                  keyPlaceholder="variable"
                  valuePlaceholder="value — use as {{variable}}"
                  addLabel="Add variable"
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraftEnvs((prev) => [
                  ...prev,
                  { id: genId('env'), name: 'New environment', baseUrl: '', vars: [] },
                ])
              }
            >
              Add environment
            </Button>
          </div>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save}>
              Save environments
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SchemaPeek({ schema }: { schema: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-2 py-1.5 text-xs font-medium hover:bg-muted/50"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Input schema
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-border bg-muted/30 p-2 font-mono text-[11px] leading-4 scrollbar-thin">
          {JSON.stringify(schema, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function RequestBuilder() {
  const { draft, setDraft, send, cancel, sending, activeEnv, saveDraftTo, collections } =
    useDevTools();
  const toast = useToast();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveCollectionId, setSaveCollectionId] = useState<string>('__new__');
  const [saveToolOpen, setSaveToolOpen] = useState(false);

  const vars = useMemo(() => buildVarMap(activeEnv), [activeEnv]);
  const placeholders = useMemo(
    () => (draft.kind === 'http' ? pathPlaceholders(substituteVars(draft.url, vars)) : []),
    [draft.kind, draft.url, vars],
  );

  const formatBody = () => {
    try {
      const parsed = JSON.parse(draft.body.text) as unknown;
      setDraft((d) => ({ ...d, body: { ...d.body, text: JSON.stringify(parsed, null, 2) } }));
    } catch {
      toast.error('Body is not valid JSON.');
    }
  };

  const openSave = () => {
    setSaveName(draft.name === 'Untitled request' ? '' : draft.name);
    setSaveCollectionId(collections[0]?.id ?? '__new__');
    setSaveOpen(true);
  };
  const confirmSave = () => {
    const name = saveName.trim() || draft.name || 'Untitled request';
    saveDraftTo(saveCollectionId === '__new__' ? null : saveCollectionId, name);
    setSaveOpen(false);
    toast.success(`Saved “${name}”`);
  };

  const runButton = (
    <div className="flex shrink-0 items-center gap-1.5">
      {sending ? (
        <Button type="button" variant="outline" size="sm" onClick={cancel}>
          <X /> Cancel
        </Button>
      ) : (
        <Button type="button" size="sm" onClick={() => void send()}>
          <Send /> {draft.kind === 'http' ? 'Send' : 'Run'}
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{draft.name}</span>
          {draft.kind !== 'http' && <KindBadge kind={draft.kind} className="w-auto" />}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {draft.kind === 'http' && <EnvironmentControls />}
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={openSave}>
            <Save /> Save
          </Button>
          {draft.kind === 'http' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              title="Turn this request into a tool agents can call"
              onClick={() => setSaveToolOpen(true)}
            >
              <Wand2 /> Save as agent tool
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
        {draft.kind === 'http' ? (
          <div className="space-y-3">
            {draft.description && (
              <p className="text-xs text-muted-foreground">{draft.description}</p>
            )}
            <div className="flex items-center gap-1.5">
              <Select
                value={draft.method}
                onValueChange={(m) => setDraft((d) => ({ ...d, method: m as HttpMethod }))}
              >
                <SelectTrigger className="h-9 w-24 font-mono text-xs font-semibold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-xs">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                placeholder="{{baseUrl}}/api/… or https://…"
                className="h-9 flex-1 font-mono text-xs"
              />
              {runButton}
            </div>

            {placeholders.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {placeholders.map((p) => {
                  const filled = Boolean(draft.pathValues[p]);
                  return (
                    <label
                      key={p}
                      className={cn(
                        'flex items-center gap-1 rounded-md border px-1.5 py-0.5',
                        filled ? 'border-border' : 'border-destructive/50',
                      )}
                    >
                      <span className="font-mono text-[10px] text-muted-foreground">{`{${p}}`}</span>
                      <input
                        value={draft.pathValues[p] ?? ''}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            pathValues: { ...d.pathValues, [p]: e.target.value },
                          }))
                        }
                        placeholder="value"
                        className="w-40 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/50"
                      />
                    </label>
                  );
                })}
              </div>
            )}

            <Tabs defaultValue="params">
              <TabsList className="h-8">
                <TabsTrigger value="params" className="text-xs">
                  Params{draft.params.filter((p) => p.enabled && p.key).length > 0 && ` (${draft.params.filter((p) => p.enabled && p.key).length})`}
                </TabsTrigger>
                <TabsTrigger value="headers" className="text-xs">
                  Headers{draft.headers.filter((h) => h.enabled && h.key).length > 0 && ` (${draft.headers.filter((h) => h.enabled && h.key).length})`}
                </TabsTrigger>
                <TabsTrigger value="body" className="text-xs">
                  Body{draft.body.mode !== 'none' && ' ●'}
                </TabsTrigger>
                <TabsTrigger value="auth" className="text-xs">
                  Auth
                </TabsTrigger>
              </TabsList>

              <TabsContent value="params" className="pt-2">
                <KvEditor
                  entries={draft.params}
                  onChange={(params) => setDraft((d) => ({ ...d, params }))}
                  keyPlaceholder="query key"
                  valuePlaceholder="value — {{vars}} allowed"
                  addLabel="Add param"
                />
              </TabsContent>

              <TabsContent value="headers" className="pt-2">
                <KvEditor
                  entries={draft.headers}
                  onChange={(headers) => setDraft((d) => ({ ...d, headers }))}
                  keyPlaceholder="header"
                  valuePlaceholder="value — {{secret:service/label}} allowed"
                  addLabel="Add header"
                />
                <p className="pt-2 text-[11px] text-muted-foreground">
                  Vault refs like <code className="font-mono">{'{{secret:mapbox/default}}'}</code>{' '}
                  resolve server-side — the plaintext never reaches the browser.
                </p>
                <VaultRefChips />
              </TabsContent>

              <TabsContent value="body" className="space-y-2 pt-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={draft.body.mode}
                    onValueChange={(m) =>
                      setDraft((d) => ({ ...d, body: { ...d.body, mode: m as BodyMode } }))
                    }
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none" className="text-xs">None</SelectItem>
                      <SelectItem value="json" className="text-xs">JSON</SelectItem>
                      <SelectItem value="raw" className="text-xs">Raw</SelectItem>
                    </SelectContent>
                  </Select>
                  {draft.body.mode === 'json' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={formatBody}
                    >
                      Format
                    </Button>
                  )}
                </div>
                {draft.body.mode !== 'none' && (
                  <Textarea
                    value={draft.body.text}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, body: { ...d.body, text: e.target.value } }))
                    }
                    rows={10}
                    className="font-mono text-xs"
                    placeholder={draft.body.mode === 'json' ? '{\n  "key": "value"\n}' : 'request body'}
                  />
                )}
              </TabsContent>

              <TabsContent value="auth" className="space-y-2 pt-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Mode</Label>
                  <Select
                    value={draft.auth.mode}
                    onValueChange={(m) =>
                      setDraft((d) => ({ ...d, auth: { ...d.auth, mode: m as AuthMode } }))
                    }
                  >
                    <SelectTrigger className="h-8 w-56 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="session" className="text-xs">
                        Session — your login cookie
                      </SelectItem>
                      <SelectItem value="bearer" className="text-xs">
                        Bearer token
                      </SelectItem>
                      <SelectItem value="none" className="text-xs">
                        None
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.auth.mode === 'bearer' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Token</Label>
                    <Input
                      value={draft.auth.token ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, auth: { ...d.auth, token: e.target.value } }))
                      }
                      placeholder="token — {{secret:service/label}} allowed"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Session auth rides the same-origin cookie — built-in API calls just work.
                  Saved requests and history never store tokens.
                </p>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <code className="font-mono text-sm font-semibold">{draft.targetName}</code>
                {draft.description && (
                  <p className="text-xs text-muted-foreground">{draft.description}</p>
                )}
                <p className="text-[11px] text-muted-foreground/70">
                  {draft.kind === 'tool'
                    ? 'Runs through the same dispatcher agents use — templating, vault secrets, timeouts included.'
                    : 'Invoked on the live MCP server — exactly what Claude Desktop would get.'}
                </p>
              </div>
              {runButton}
            </div>
            {draft.schema && <SchemaPeek schema={draft.schema} />}
            <div className="space-y-1.5">
              <Label className="text-xs">Arguments (JSON)</Label>
              <Textarea
                value={draft.argsText}
                onChange={(e) => setDraft((d) => ({ ...d, argsText: e.target.value }))}
                rows={12}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {/* Save-to-collection dialog */}
      <Dialog open={saveOpen} onOpenChange={(o) => !o && setSaveOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="save-name" className="text-xs">
                Name
              </Label>
              <Input
                id="save-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={draft.name}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Collection</Label>
              <Select value={saveCollectionId} onValueChange={setSaveCollectionId}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">
                      {c.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__" className="text-xs">
                    New collection…
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={confirmSave}>
              Save request
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <SaveToolDialog open={saveToolOpen} onOpenChange={setSaveToolOpen} />
    </div>
  );
}
