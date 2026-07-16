'use client';

/**
 * Agent Studio Phase 2 — editable prose with version history (docs/agent-studio.md).
 *
 * Renders one human-editable prompt field (agent system prompt, skill
 * instructions, worker prompt). View → edit → save creates a new version;
 * History shows the timeline with a git-style diff (selected version → current)
 * and one-click revert. On save it calls `onSaved` so the parent can refresh the
 * server-computed composed-prompt preview (live re-compose).
 */

import { useCallback, useState } from 'react';
import { History, Pencil, RotateCcw, Save, X } from 'lucide-react';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { lineDiff } from '@/lib/studio/diff';

type Version = {
  id: string;
  version: number;
  body: string;
  note: string | null;
  createdAt: string;
};

function Prose({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[13px] leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

function DiffView({ from, to }: { from: string; to: string }) {
  const lines = lineDiff(from, to);
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[13px] leading-relaxed">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.type === 'add'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : l.type === 'del'
                ? 'bg-destructive/10 text-destructive'
                : 'text-muted-foreground'
          }
        >
          <span className="select-none opacity-60">
            {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
          </span>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

export function ProseEditor({
  entityType,
  entityId,
  field,
  value,
  onSaved,
}: {
  entityType: string;
  entityId: string;
  field: string;
  value: string;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'history'>('view');
  const [draft, setDraft] = useState(value);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [diffFrom, setDiffFrom] = useState<number | null>(null);

  const loadVersions = useCallback(async () => {
    setVersions(null);
    const qs = new URLSearchParams({ entityType, entityId, field });
    try {
      const json = await apiFetch<{ versions?: Version[] }>(`/api/studio/prose?${qs}`);
      setVersions(json.versions ?? []);
    } catch {
      setVersions([]);
    }
  }, [entityType, entityId, field]);

  async function post(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const json = await apiSend<{ versions?: Version[] }>('/api/studio/prose', 'POST', {
        entityType,
        entityId,
        field,
        ...payload,
      });
      setVersions(json.versions ?? []);
      onSaved();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const ok = await post({ body: draft, note: note.trim() || null });
    if (ok) {
      setNote('');
      setMode('view');
    }
  }

  async function revert(toVersion: number) {
    await post({ revertTo: toVersion });
  }

  // ── edit ──
  if (mode === 'edit') {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          className="font-mono text-[13px] leading-relaxed"
          spellCheck={false}
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What changed / why? (optional note)"
          className="text-sm"
        />
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={busy}>
            <Save /> Save version
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(value);
              setNote('');
              setError(null);
              setMode('view');
            }}
            disabled={busy}
          >
            <X /> Cancel
          </Button>
        </div>
      </div>
    );
  }

  // ── history ──
  if (mode === 'history') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
            History
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMode('view');
              setDiffFrom(null);
            }}
          >
            <X /> Close
          </Button>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        {versions === null ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No saved versions yet — this field hasn’t been edited in the Studio.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {versions.map((v) => (
              <div key={v.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold tabular-nums">v{v.version}</span>
                    <span className="text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </span>
                    {v.note && <span className="italic text-muted-foreground">· {v.note}</span>}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[13px]"
                      onClick={() => setDiffFrom(diffFrom === v.version ? null : v.version)}
                    >
                      {diffFrom === v.version ? 'hide diff' : 'diff'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[13px]"
                      onClick={() => revert(v.version)}
                      disabled={busy}
                    >
                      <RotateCcw className="size-3" /> revert
                    </Button>
                  </span>
                </div>
                {diffFrom === v.version && <DiffView from={v.body} to={value} />}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── view ──
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[13px]"
          onClick={() => {
            setDraft(value);
            setMode('edit');
          }}
        >
          <Pencil className="size-3" /> Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[13px]"
          onClick={() => {
            setMode('history');
            void loadVersions();
          }}
        >
          <History className="size-3" /> History
        </Button>
      </div>
      <Prose text={value || '(empty)'} />
    </div>
  );
}
