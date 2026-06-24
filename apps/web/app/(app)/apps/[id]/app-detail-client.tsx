'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Hammer, Rocket, Undo2, Sparkles, SquareDashedMousePointer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { BackLink } from '@/components/layout/back-link';
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import { CodeView } from '@/components/app-sandbox/code-view';
import { FileTree } from '@/components/app-sandbox/file-tree';
import type { AppDetail } from '@mantle/content';

type BuildMsg = { text: string; location: { file: string; line: number; column: number } | null };

export function AppDetailClient({ app }: { app: AppDetail }) {
  const router = useRouter();
  const toast = useToast();

  const source = app.draft ?? app.source;
  const paths = useMemo(() => Object.keys(source.files).sort(), [source.files]);
  const [activePath, setActivePath] = useState(source.entry);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<null | 'build' | 'publish' | 'discard' | 'assist'>(null);
  const [buildErrors, setBuildErrors] = useState<BuildMsg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  // Inspect-to-focus: the region the user locked in the preview, and whether
  // select mode is active. Both reset whenever the app reloads (rebuild/publish).
  const [inspect, setInspect] = useState(false);
  const [focusRegion, setFocusRegion] = useState<string | null>(null);

  const activeContent = source.files[activePath] ?? source.files[source.entry] ?? '';

  useEffect(() => {
    setInspect(false);
    setFocusRegion(null);
  }, [reloadKey]);

  async function build() {
    setBusy('build');
    setBuildErrors([]);
    try {
      const res = await fetch(`/api/apps/${app.id}/build`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Build failed.');
        return;
      }
      setBuildErrors(data.errors ?? []);
      if (data.buildOk) {
        toast.success('Build succeeded.');
        setReloadKey((k) => k + 1);
      } else {
        toast.error(`Build failed (${data.errors?.length ?? 0} error(s)).`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy('publish');
    try {
      const res = await fetch(`/api/apps/${app.id}/publish`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Publish failed.');
        return;
      }
      toast.success('Published.');
      router.refresh();
      setReloadKey((k) => k + 1);
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    setBusy('discard');
    try {
      const res = await fetch(`/api/apps/${app.id}/draft`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not discard the draft.');
        return;
      }
      toast.success('Draft discarded.');
      router.refresh();
      setReloadKey((k) => k + 1);
    } finally {
      setBusy(null);
    }
  }

  async function runAssist(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy('assist');
    setReply(null);
    setBuildErrors([]);
    try {
      const res = await fetch(`/api/apps/${app.id}/ai-assist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          ...(focusRegion ? { focusRegionIds: [focusRegion] } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Appsmith couldn’t run.');
        return;
      }
      setReply(data.reply ?? '');
      setBuildErrors(data.build?.errors ?? []);
      setPrompt('');
      router.refresh();
      setReloadKey((k) => k + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border p-3">
        <div className="flex items-center gap-3">
          <BackLink href="/apps">Apps</BackLink>
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden>{app.icon ?? '🧩'}</span>
            {app.title}
            {app.hasDraft && <Badge variant="secondary">unpublished draft</Badge>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={build} disabled={busy !== null}>
            <Hammer />
            Build
          </Button>
          {app.hasDraft && (
            <Button size="sm" variant="ghost" onClick={discard} disabled={busy !== null}>
              <Undo2 />
              Discard
            </Button>
          )}
          <Button size="sm" onClick={publish} disabled={busy !== null || !app.draftBuild?.ok}>
            <Rocket />
            Publish
          </Button>
        </div>
      </div>

      <Tabs defaultValue="builder" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b border-border px-3 py-2">
          <TabsList>
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
        </div>

        {/* Builder — open two-column: live preview + Appsmith assist. */}
        <TabsContent
          value="builder"
          className="mt-0 grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
        >
          <div className="flex min-h-0 flex-col overflow-y-auto border-r border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <Button
                size="sm"
                variant={inspect ? 'default' : 'outline'}
                onClick={() => setInspect((v) => !v)}
                title="Click a region in the preview to focus Appsmith on it"
              >
                <SquareDashedMousePointer />
                {inspect ? 'Selecting… (Esc)' : 'Select element'}
              </Button>
              {inspect && (
                <span className="text-xs text-muted-foreground">
                  Hover a region, click to focus it.
                </span>
              )}
            </div>
            <AppSandbox
              appId={app.id}
              reloadKey={reloadKey}
              onError={(m) => toast.error(m)}
              inspect={inspect}
              selectedRegionId={focusRegion}
              onSelect={setFocusRegion}
              onInspectChange={setInspect}
            />
            {buildErrors.length > 0 && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                <p className="mb-1 font-medium">Build errors</p>
                <ul className="flex flex-col gap-1">
                  {buildErrors.map((e, i) => (
                    <li key={i}>
                      {e.location ? `${e.location.file}:${e.location.line} — ` : ''}
                      {e.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-col overflow-y-auto bg-sidebar p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="size-4" />
              Appsmith
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Describe a change and Appsmith edits the app. Use <span className="font-medium">Select
              element</span> to point it at one region. Changes land in the draft — review the
              preview, then Publish.
            </p>
            <Separator className="my-3" />
            {focusRegion && (
              <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-card-foreground">
                <SquareDashedMousePointer className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  Focusing <span className="font-medium">{focusRegion}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setFocusRegion(null)}
                  className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                  aria-label="Clear focus"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            <form onSubmit={runAssist} className="flex flex-col gap-2">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. show a 5-day forecast in a grid"
                rows={3}
                disabled={busy === 'assist'}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !prompt.trim()}>
                {busy === 'assist' ? 'Working…' : 'Send to Appsmith'}
              </Button>
            </form>
            {reply && (
              <div className="mt-3 whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
                {reply}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Code — file-tree sidebar + a syntax-highlighted source viewer. */}
        <TabsContent
          value="code"
          className="mt-0 grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)]"
        >
          <FileTree
            paths={paths}
            entry={source.entry}
            activePath={activePath}
            onSelect={setActivePath}
            className="border-r border-border"
          />
          <CodeView path={activePath} content={activeContent} className="min-h-0" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
