'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Eye,
  GitCommitHorizontal,
  Undo2,
  SquareDashedMousePointer,
  X,
  Save,
  WandSparkles,
} from 'lucide-react';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import { Badge } from '@mantle/web-ui/ui/badge';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mantle/web-ui/ui/tabs';
import { useToast } from '@mantle/web-ui/ui/toast';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@mantle/web-ui/layout/back-link';
import { EmojiPicker } from '@/components/emoji-picker';
import { ShareControl } from '@/components/share-control';
import { AppSandbox } from '@mantle/web-ui/app-sandbox/app-sandbox';
import { AppAccessLog } from '@mantle/web-ui/app-sandbox/access-log';
import { CodeEditor } from '@mantle/web-ui/app-sandbox/code-editor';
import { FileTree } from '@mantle/web-ui/app-sandbox/file-tree';
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

  // Icon edits are optimistic-local + a fire-and-forget PATCH. Deliberately NO
  // query invalidation: reloading the app here re-syncs the source tree and
  // would drop unsaved editor changes for a cosmetic write.
  const [icon, setIcon] = useState<string | null>(app.icon);
  useEffect(() => setIcon(app.icon), [app.icon]);
  const saveIcon = async (next: string) => {
    const prev = icon;
    setIcon(next || null);
    try {
      await apiSend(`/api/apps/${app.id}`, 'PATCH', { icon: next });
    } catch (err) {
      setIcon(prev);
      toast.error(err instanceof Error ? err.message : 'Could not save the icon');
    }
  };

  const source = app.draft ?? app.source;
  // Editable working copy of the source tree. Re-synced from the server on every
  // reload (build / publish / discard / assist), which also drops local edits.
  const [files, setFiles] = useState<Record<string, string>>(source.files);
  const [dirty, setDirty] = useState(false);
  const paths = useMemo(() => Object.keys(files).sort(), [files]);
  const [activePath, setActivePath] = useState(source.entry);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<null | 'preview' | 'commit' | 'discard' | 'save' | 'format'>(
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

  /** Compile the draft and refresh the preview. Does NOT go live. */
  async function preview() {
    // Unsaved editor changes must reach the draft before we compile it.
    if (dirty && !(await saveDraft())) return;
    setBusy('preview');
    setBuildErrors([]);
    try {
      const data = await apiSend<{ errors?: BuildMsg[]; buildOk?: boolean }>(
        `/api/apps/${app.id}/build`,
        'POST',
      );
      setBuildErrors(data.errors ?? []);
      if (data.buildOk) {
        toast.success('Preview updated.');
        await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
        setReloadKey((k) => k + 1);
      } else {
        toast.error(`${data.errors?.length ?? 0} error(s) — preview not updated.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the preview.');
    } finally {
      setBusy(null);
    }
  }

  /** Go live: the route compiles the draft itself and promotes it only on a
   *  clean build, so the live source and the live bundle always agree. */
  async function commit() {
    if (dirty && !(await saveDraft())) return;
    setBusy('commit');
    setBuildErrors([]);
    try {
      await apiSend(`/api/apps/${app.id}/publish`, 'POST');
      toast.success('Committed — the live app is updated.');
      await queryClient.invalidateQueries({ queryKey: ['apps', app.id] });
      setReloadKey((k) => k + 1);
    } catch (err) {
      // 422 = the commit's own build failed; surface the errors in the panel
      // rather than a bare toast, exactly as a Preview failure would.
      if (err instanceof ApiError && err.status === 422) {
        const errors = (err.body?.errors as BuildMsg[] | undefined) ?? [];
        setBuildErrors(errors);
        toast.error(`${errors.length} error(s) — nothing was committed.`);
      } else {
        toast.error(err instanceof Error ? err.message : 'Commit failed.');
      }
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
  // the old in-builder Appsmith panel; the draft/Commit flow is unchanged.
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
    node: { id: app.id, kind: 'app', label: app.title },
    focusDirective,
    onEdited: onAppEdited,
  });

  // Persist the edited file tree to the draft. Returns true on success so
  // Preview and Commit can save-then-compile when there are unsaved edits.
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
            <EmojiPicker
              value={icon || null}
              onSelect={(e) => void saveIcon(e)}
              onClear={() => void saveIcon('')}
              align="start"
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="Change app icon"
                  title="Change icon"
                  className="size-8 shrink-0 rounded-md p-0 text-lg leading-none hover:bg-accent"
                >
                  {icon || '🧩'}
                </Button>
              }
            />
            {app.title}
            {app.hasDraft && <Badge variant="secondary">unpublished draft</Badge>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={preview}
            disabled={busy !== null}
            title="Compile the draft and refresh the preview — does not go live"
          >
            <Eye />
            Preview
          </Button>
          {app.hasDraft && (
            <Button size="sm" variant="ghost" onClick={discard} disabled={busy !== null}>
              <Undo2 />
              Discard
            </Button>
          )}
          {/* Commit compiles the draft itself, so it gates on there being
              something staged, not on a build having been run by hand. */}
          <Button
            size="sm"
            onClick={commit}
            disabled={busy !== null || (!app.hasDraft && !dirty)}
            title="Compile the draft and make it live"
          >
            <GitCommitHorizontal />
            Commit
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
              <div className="mt-3 max-h-48 shrink-0 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-ink">
                <p className="mb-1 font-medium">Compile errors</p>
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
