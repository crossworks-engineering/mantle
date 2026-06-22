'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Hammer, Rocket, Undo2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/ui/toast';
import { BackLink } from '@/components/layout/back-link';
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import { cn } from '@/lib/utils';
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

  const activeContent = source.files[activePath] ?? source.files[source.entry] ?? '';

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
        body: JSON.stringify({ prompt: prompt.trim() }),
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

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px]">
        {/* Source viewer */}
        <div className="flex min-h-0 flex-col border-r border-border">
          <div className="flex flex-wrap gap-1 border-b border-border p-2">
            {paths.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setActivePath(p)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  p === activePath
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-foreground/[0.06]',
                )}
              >
                {p}
                {p === source.entry ? ' ·entry' : ''}
              </button>
            ))}
          </div>
          <pre className="min-h-0 flex-1 overflow-auto bg-card p-3 text-xs leading-relaxed text-card-foreground">
            <code>{activeContent}</code>
          </pre>
        </div>

        {/* Live preview */}
        <div className="flex min-h-0 flex-col overflow-y-auto border-r border-border p-3">
          <AppSandbox appId={app.id} reloadKey={reloadKey} onError={(m) => toast.error(m)} />
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

        {/* Assist panel */}
        <div className="flex min-h-0 flex-col overflow-y-auto bg-sidebar p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4" />
            Appsmith
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Describe a change and Appsmith edits the app. Changes land in the draft — review the
            preview, then Publish.
          </p>
          <Separator className="my-3" />
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
      </div>
    </div>
  );
}
