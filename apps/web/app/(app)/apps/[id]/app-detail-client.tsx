'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Hammer, Rocket, Undo2, Sparkles, SquareDashedMousePointer, X, Save, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { BackLink } from '@/components/layout/back-link';
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import { CodeEditor } from '@/components/app-sandbox/code-editor';
import { FileTree } from '@/components/app-sandbox/file-tree';
import { useAssistStage, SpecialistWorking } from '@/components/specialist-working';
import type { AppDetail } from '@mantle/content';

type BuildMsg = { text: string; location: { file: string; line: number; column: number } | null };

// Extensions the /format (Prettier) route handles — mirror its PARSER map so the
// button only enables for files the server can actually format.
const FORMATTABLE = new Set([
  'tsx', 'ts', 'jsx', 'js', 'mjs', 'cjs', 'css', 'scss', 'less', 'json', 'html', 'htm', 'md', 'markdown',
]);
const extOf = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

export function AppDetailClient({ app }: { app: AppDetail }) {
  const router = useRouter();
  const toast = useToast();

  const source = app.draft ?? app.source;
  // Editable working copy of the source tree. Re-synced from the server on every
  // reload (build / publish / discard / assist), which also drops local edits.
  const [files, setFiles] = useState<Record<string, string>>(source.files);
  const [dirty, setDirty] = useState(false);
  const paths = useMemo(() => Object.keys(files).sort(), [files]);
  const [activePath, setActivePath] = useState(source.entry);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<null | 'build' | 'publish' | 'discard' | 'assist' | 'save' | 'format'>(null);
  const [buildErrors, setBuildErrors] = useState<BuildMsg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  // Inspect-to-focus: the region the user locked in the preview, and whether
  // select mode is active. Both reset whenever the app reloads (rebuild/publish).
  const [inspect, setInspect] = useState(false);
  const [focusRegion, setFocusRegion] = useState<string | null>(null);
  // Live "what is Appsmith doing" label, polled while an assist run is in flight.
  const assistStage = useAssistStage('/api/assist/stage?surface=apps', busy === 'assist');

  const activeContent = files[activePath] ?? files[source.entry] ?? '';
  const canFormat = FORMATTABLE.has(extOf(activePath));

  useEffect(() => {
    setInspect(false);
    setFocusRegion(null);
  }, [reloadKey]);

  // Re-sync the editable copy whenever the server source changes (a build,
  // publish, discard, or an Appsmith edit). Drops any unsaved local edits.
  useEffect(() => {
    setFiles(source.files);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  async function build() {
    // Unsaved editor changes must reach the draft before we compile it.
    if (dirty && !(await saveDraft())) return;
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

  // Persist the edited file tree to the draft. Returns true on success so the
  // Build action can save-then-build when there are unsaved edits.
  async function saveDraft(): Promise<boolean> {
    setBusy('save');
    try {
      const res = await fetch(`/api/apps/${app.id}/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: source.entry, files }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? 'Could not save.');
        return false;
      }
      setDirty(false);
      toast.success('Saved to draft.');
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function formatActive() {
    setBusy('format');
    try {
      const res = await fetch(`/api/apps/${app.id}/format`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: activePath, content: activeContent }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Could not format.');
        return;
      }
      if (data.formatted !== activeContent) {
        setFiles((f) => ({ ...f, [activePath]: data.formatted }));
        setDirty(true);
      }
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
            {busy === 'assist' && (
              <div className="mt-3">
                <SpecialistWorking stage={assistStage} agentName="Appsmith" />
              </div>
            )}
            {busy !== 'assist' && reply && (
              <div className="mt-3 whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
                {reply}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Code — file-tree sidebar + an editable, syntax-highlighted editor. */}
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
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {activePath}
                {dirty && <span className="ml-1.5 text-foreground">●</span>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={formatActive}
                disabled={busy !== null || !canFormat}
                title={canFormat ? 'Format with Prettier' : 'No formatter for this file type'}
              >
                <WandSparkles />
                {busy === 'format' ? 'Formatting…' : 'Format'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={saveDraft}
                disabled={busy !== null || !dirty}
              >
                <Save />
                {busy === 'save' ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <CodeEditor
              path={activePath}
              value={activeContent}
              onChange={(next) => {
                setFiles((f) => ({ ...f, [activePath]: next }));
                setDirty(true);
              }}
              className="min-h-0 flex-1"
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
