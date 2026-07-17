'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Hammer,
  Rocket,
  Undo2,
  SquareDashedMousePointer,
  X,
  Save,
  WandSparkles,
} from 'lucide-react';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { ShareControl } from '@/components/share/share-control';
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import { AppAccessLog } from '@/components/app-sandbox/access-log';
import { CodeEditor } from '@/components/app-sandbox/code-editor';
import { FileTree } from '@/components/app-sandbox/file-tree';
import { useSurfaceAssist } from '@/components/assistant/use-surface-assist';
import type { AppDetail } from '@mantle/content';

type BuildMsg = { text: string; location: { file: string; line: number; column: number } | null };

// Extensions the /format (Prettier) route handles — mirror its PARSER map so the
// button only enables for files the server can actually format.
const FORMATTABLE = new Set([
  'tsx',
  'ts',
  'jsx',
  'js',
  'mjs',
  'cjs',
  'css',
  'scss',
  'less',
  'json',
  'html',
  'htm',
  'md',
  'markdown',
]);
const extOf = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

/** Outer query-gate so the page stays data-free. */
export function AppDetailClient({ id }: { id: string }) {
  const appQuery = useQuery({
    queryKey: ['apps', id],
    queryFn: () => apiFetch<{ app: AppDetail }>(`/api/apps/${id}`),
    retry: false,
  });

  if (appQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (appQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Couldn&apos;t load this app.</p>
        <BackLink href="/apps">Back to apps</BackLink>
      </div>
    );
  }
  return <AppDetailView app={appQuery.data.app} />;
}

function AppDetailView({ app }: { app: AppDetail }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const source = app.draft ?? app.source;
  // Editable working copy of the source tree. Re-synced from the server on every
  // reload (build / publish / discard / assist), which also drops local edits.
  const [files, setFiles] = useState<Record<string, string>>(source.files);
  const [dirty, setDirty] = useState(false);
  const paths = useMemo(() => Object.keys(files).sort(), [files]);
  const [activePath, setActivePath] = useState(source.entry);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<null | 'build' | 'publish' | 'discard' | 'save' | 'format'>(
    null,
  );
  const [buildErrors, setBuildErrors] = useState<BuildMsg[]>([]);
  // Inspect-to-focus: the region the user locked in the preview, and whether
  // select mode is active. Both reset whenever the app reloads (rebuild/publish).
  const [inspect, setInspect] = useState(false);
  const [focusRegion, setFocusRegion] = useState<string | null>(null);

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
      const data = await apiSend<{ errors?: BuildMsg[]; buildOk?: boolean }>(
        `/api/apps/${app.id}/build`,
        'POST',
      );
      setBuildErrors(data.errors ?? []);
      if (data.buildOk) {
        toast.success('Build succeeded.');
        await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
        setReloadKey((k) => k + 1);
      } else {
        toast.error(`Build failed (${data.errors?.length ?? 0} error(s)).`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Build failed.');
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy('publish');
    try {
      await apiSend(`/api/apps/${app.id}/publish`, 'POST');
      toast.success('Published.');
      await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    setBusy('discard');
    try {
      await apiSend(`/api/apps/${app.id}/draft`, 'DELETE');
      toast.success('Draft discarded.');
      await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
      setReloadKey((k) => k + 1);
    } catch {
      toast.error('Could not discard the draft.');
    } finally {
      setBusy(null);
    }
  }

  // Wire the global assistant overlay to this app: arm the Appsmith specialist,
  // pin this app as context, fold the inspect-selected region into a focus
  // directive, and rebuild the preview when Appsmith edits the draft. Replaces
  // the old in-builder Appsmith panel; the draft/Publish flow is unchanged.
  const focusDirective = useMemo(
    () =>
      focusRegion
        ? `FOCUS REGION — the user selected the region "${focusRegion}" in the live ` +
          `preview. Scope your change to that region and leave the rest of the app ` +
          `unchanged unless explicitly asked.`
        : null,
    [focusRegion],
  );
  const onAppEdited = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
    setReloadKey((k) => k + 1);
  }, [queryClient, app.id]);
  useSurfaceAssist({
    surface: 'apps',
    node: { id: app.id, kind: 'app', label: app.title },
    focusDirective,
    onEdited: onAppEdited,
  });

  // Persist the edited file tree to the draft. Returns true on success so the
  // Build action can save-then-build when there are unsaved edits.
  async function saveDraft(): Promise<boolean> {
    setBusy('save');
    try {
      await apiSend(`/api/apps/${app.id}/draft`, 'PUT', { entry: source.entry, files });
      setDirty(false);
      toast.success('Saved to draft.');
      await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function formatActive() {
    setBusy('format');
    try {
      const data = await apiSend<{ formatted: string }>(`/api/apps/${app.id}/format`, 'POST', {
        path: activePath,
        content: activeContent,
      });
      if (data.formatted !== activeContent) {
        setFiles((f) => ({ ...f, [activePath]: data.formatted }));
        setDirty(true);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not format.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SetPageTitle title={app.title} />
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
          {/* Share the published app at a public full-screen /s/<token> URL.
              Only once there's a published build to point the link at. */}
          {app.publishedBuild?.ok && (
            <ShareControl
              nodeId={app.id}
              teamMode
              teamHint="Visitors must enter their team token, and every action is audited to that member. Team members can use the app’s Mantle tools and write to its data — a public link can only read the app’s own data. Grant it to people you trust."
            />
          )}
        </div>
      </div>

      <Tabs defaultValue="builder" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b border-border px-3 py-2">
          <TabsList>
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </div>

        {/* Builder — the live preview. Ask Appsmith to edit the app via the
            global assistant (⌘I), auto-armed for this app; "Select element"
            focuses it on one region. */}
        <TabsContent value="builder" className="mt-0 flex min-h-0 flex-1 flex-col">
          {/* The preview is a real viewport (frame="viewport"): the sandbox
              fills the pane and the app handles its own scrolling, exactly as
              it will on the shared /s/ surface. */}
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
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
              {focusRegion && (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-card-foreground">
                  <SquareDashedMousePointer className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 max-w-[16rem] truncate">
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
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1">
              <AppSandbox
                appId={app.id}
                frame="viewport"
                reloadKey={reloadKey}
                onError={(m) => toast.error(m)}
                inspect={inspect}
                selectedRegionId={focusRegion}
                onSelect={setFocusRegion}
                onInspectChange={setInspect}
              />
            </div>
            {buildErrors.length > 0 && (
              // shrink-0 + its own scroll so the flex-1 sandbox above can't
              // squeeze the errors to zero height in the non-scrolling column.
              <div className="mt-3 max-h-48 shrink-0 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
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

        {/* Activity — the external access log (who opened/used the shared app). */}
        <TabsContent value="activity" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <AppAccessLog appId={app.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
