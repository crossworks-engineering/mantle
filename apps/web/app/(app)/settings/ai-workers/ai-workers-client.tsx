'use client';

import { useEffect, useState, useTransition } from 'react';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { AiWorker, AiWorkerKind } from '@mantle/db';
import { getProvider } from '@mantle/voice';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { WorkerForm } from './worker-form';

type KeyOption = { id: string; service: string; label: string; masked: string };

/** Display metadata per kind — section label + one-liner. */
const KIND_META: Record<AiWorkerKind, { label: string; description: string }> = {
  reflector: {
    label: 'Reflector',
    description:
      'Background pass that watches dialog and appends style/relationship/correction notes to the responder.',
  },
  extractor: {
    label: 'Extractor',
    description:
      'Reads each ingested node and produces summary + entities + facts. Drives content_index.',
  },
  summarizer: {
    label: 'Summarizer',
    description: 'Rolls Telegram conversations into topic-based digests (Tier-2 memory).',
  },
  tts: {
    label: 'Voice (TTS)',
    description:
      'Spoken replies. Used when the user sends a voice message or the responder emits a [VOICE] marker.',
  },
  stt: {
    label: 'Transcription (STT)',
    description:
      'Voice messages → text. Runs before the responder sees anything so the prompt contains real words.',
  },
  vision: {
    label: 'Vision',
    description:
      'Image → text. Whiteboards, receipts, document scans. Not wired in yet — config saved for when it lands.',
  },
  image_gen: { label: 'Image generation', description: 'Text → image. Reserved for future tooling.' },
  embedding: {
    label: 'Embedding',
    description:
      'Text → 1536-dim vector. Drives the brain index, semantic memory retrieval, and the recall/MCP/spill-store search paths. One pick applies everywhere.',
  },
};

// Note: this is a plain string[] (not a Record key set), so TS doesn't
// enforce exhaustiveness. When a new kind lands in the enum, ADD IT HERE
// or it'll be silently absent from the sidebar list.
const KIND_ORDER: AiWorkerKind[] = [
  'tts',
  'stt',
  'vision',
  'extractor',
  'summarizer',
  'reflector',
  'embedding',
  'image_gen',
];

type Selection =
  | { mode: 'edit'; id: string }
  | { mode: 'create'; kind: AiWorkerKind }
  | null;

export function AiWorkersClient({
  workers,
  keys,
  initialSelectedId,
  createAction,
  updateAction,
  deleteAction,
}: {
  workers: AiWorker[];
  keys: KeyOption[];
  initialSelectedId: string | null;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (id: string, formData: FormData) => Promise<void>;
  deleteAction: (id: string) => Promise<void>;
}) {
  const [sel, setSel] = useState<Selection>(
    initialSelectedId ? { mode: 'edit', id: initialSelectedId } : null,
  );
  const [deleteTarget, setDeleteTarget] = useState<AiWorker | null>(null);
  const [, startTransition] = useTransition();

  // After a create redirect (?selected=newId), preselect the new worker.
  useEffect(() => {
    if (initialSelectedId) setSel({ mode: 'edit', id: initialSelectedId });
  }, [initialSelectedId]);

  // Re-derive the edited worker from fresh props so saves reflect immediately.
  const editWorker = sel?.mode === 'edit' ? (workers.find((w) => w.id === sel.id) ?? null) : null;
  const selectedId = sel?.mode === 'edit' ? sel.id : null;

  // Enabled / default-for-kind are header switches; reset on selection change
  // and inject into the form's submit (see WorkerForm).
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const selKey =
    sel?.mode === 'edit' ? `edit:${sel.id}` : sel?.mode === 'create' ? `create:${sel.kind}` : 'none';
  useEffect(() => {
    if (sel?.mode === 'edit') {
      const w = workers.find((x) => x.id === sel.id);
      setEnabled(w?.enabled ?? true);
      setIsDefault(w?.isDefault ?? false);
    } else if (sel?.mode === 'create') {
      setEnabled(true);
      setIsDefault(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    setSel(null);
    startTransition(() => deleteAction(id));
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: grouped worker list ───────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            AI workers
          </h2>
        </div>
        <div className="space-y-4 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {KIND_ORDER.map((kind) => {
            const meta = KIND_META[kind];
            const items = workers.filter((w) => w.kind === kind);
            return (
              <section key={kind} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {meta.label}
                  </h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setSel({ mode: 'create', kind })}
                  >
                    <Plus /> Add
                  </Button>
                </div>
                {items.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground/60">None configured.</p>
                ) : (
                  items.map((w) => {
                    const selected = selectedId === w.id;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => setSel({ mode: 'edit', id: w.id })}
                        className={cn(
                          'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-accent/40',
                          selected && 'border-l-primary bg-accent/50',
                          !w.enabled && 'opacity-60',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          {w.isDefault ? (
                            <CheckCircle2
                              className="size-4 shrink-0 text-emerald-600"
                              aria-label="Default for this kind"
                            />
                          ) : (
                            <span className="size-4 shrink-0" aria-hidden />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{w.name}</span>
                              {!w.enabled && (
                                <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                                  off
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                              <span className="shrink-0">
                                {getProvider(w.provider)?.label ?? w.provider}
                              </span>
                              <span aria-hidden>·</span>
                              <code className="truncate font-mono">{w.model}</code>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </section>
            );
          })}
        </div>
      </div>

      {/* ── Right: editor ───────────────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {sel?.mode === 'create' ? (
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">New {KIND_META[sel.kind].label}</h2>
                <p className="text-xs text-muted-foreground">{KIND_META[sel.kind].description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <WorkerToggles
                  enabled={enabled}
                  setEnabled={setEnabled}
                  isDefault={isDefault}
                  setIsDefault={setIsDefault}
                />
              </div>
            </div>
            <WorkerForm
              key={`new-${sel.kind}`}
              mode="create"
              kind={sel.kind}
              keys={keys}
              action={createAction}
              enabled={enabled}
              isDefault={isDefault}
            />
          </div>
        ) : editWorker ? (
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{editWorker.name}</h2>
                <p className="text-xs text-muted-foreground">
                  <code className="rounded bg-muted px-1.5 py-0.5">{editWorker.slug}</code> · kind:{' '}
                  {editWorker.kind} · {editWorker.usageCount} runs
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <WorkerToggles
                  enabled={enabled}
                  setEnabled={setEnabled}
                  isDefault={isDefault}
                  setIsDefault={setIsDefault}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(editWorker)}
                >
                  <Trash2 /> Delete
                </Button>
              </div>
            </div>
            <WorkerForm
              key={editWorker.id}
              mode="edit"
              kind={editWorker.kind}
              worker={editWorker}
              keys={keys}
              action={(fd) => updateAction(editWorker.id, fd)}
              enabled={enabled}
              isDefault={isDefault}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a worker to edit, or add one with the <span className="font-medium">+ Add</span>{' '}
            buttons.
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WorkerToggles({
  enabled,
  setEnabled,
  isDefault,
  setIsDefault,
}: {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  isDefault: boolean;
  setIsDefault: (v: boolean) => void;
}) {
  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        Enabled
      </label>
      <label
        className="flex cursor-pointer items-center gap-2 text-sm"
        title="The runtime picks the default when no specific worker is named"
      >
        <Switch checked={isDefault} onCheckedChange={setIsDefault} />
        Default
      </label>
    </>
  );
}
