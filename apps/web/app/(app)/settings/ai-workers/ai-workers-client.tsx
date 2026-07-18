'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { AiWorkerConfig, AiWorkerDTO, AiWorkerKind } from '@mantle/client-types';
import { getProvider } from '@mantle/voice/client';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { buildWorkerBody } from '@/lib/ai-worker-form';
import { Spinner } from '@/components/ui/spinner';
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
import { useToast } from '@/components/ui/toast';
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
  narrator: {
    label: 'Narrator',
    description:
      'Restyles the live turn “thought trail” into the assistant’s voice. Its system prompt is the verbosity dial — tune it for a terse phrase, a sentence, or a short paragraph. Falls back to the Summarizer when unset.',
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
      'Image → text. Whiteboards, receipts, photos. Also the fallback for PDFs when no Document worker is set.',
  },
  document: {
    label: 'Document (PDF)',
    description:
      'PDF → text, sent natively to the model (whole document, real tables) on Anthropic/Google — best for invoices & statements. Falls back to page OCR on other providers, or to the Vision worker if unset.',
  },
  image_gen: {
    label: 'Image generation',
    description: 'Text → image. Reserved for future tooling.',
  },
  embedding: {
    label: 'Embedding',
    description:
      'Text → 768-dim vector. Drives the brain index, semantic memory retrieval, and the recall/MCP/spill-store search paths. One pick applies everywhere.',
  },
  search: {
    label: 'Web search',
    description:
      'Live web search via Perplexity Sonar (OpenRouter). The standard, fast/cheap tier the Researcher uses for most lookups — backs the web_search tool.',
  },
  search_advanced: {
    label: 'Deep web search',
    description:
      'A stronger, slower Sonar model for hard or conflicting questions — backs the web_search_pro tool. The Researcher reaches for it only when needed.',
  },
};

// Note: this is a plain string[] (not a Record key set), so TS doesn't
// enforce exhaustiveness. When a new kind lands in the enum, ADD IT HERE
// or it'll be silently absent from the sidebar list.
const KIND_ORDER: AiWorkerKind[] = [
  'tts',
  'stt',
  'vision',
  'document',
  'extractor',
  'summarizer',
  'reflector',
  'narrator',
  // 'embedding' is retired as a worker kind — the embedder lives at
  // /settings/embedding (one config row, migration 0061). Hidden here.
  'image_gen',
  'search',
  'search_advanced',
];

type Selection = { mode: 'edit'; id: string } | { mode: 'create'; kind: AiWorkerKind } | null;

export function AiWorkersClient() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const searchParams = useSearchParams();
  const initialSelectedId = searchParams.get('selected');

  // ── Reads ─────────────────────────────────────────────────────────────────
  const workersQuery = useQuery({
    queryKey: ['ai-workers'],
    queryFn: () => apiFetch<{ workers: AiWorkerDTO[] }>('/api/ai-workers').then((r) => r.workers),
  });
  const keysQuery = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiFetch<{ keys: KeyOption[] }>('/api/keys').then((r) => r.keys),
  });
  const configQuery = useQuery({
    queryKey: ['ai-workers', 'config'],
    queryFn: () => apiFetch<AiWorkerConfig>('/api/ai-workers/config'),
  });
  const workers = workersQuery.data ?? [];
  const keys = keysQuery.data ?? [];
  const nativeDocProviders = configQuery.data?.nativeDocProviders ?? [];
  const tailnetPeers = configQuery.data?.tailnetPeers ?? [];

  const [sel, setSel] = useState<Selection>(
    initialSelectedId ? { mode: 'edit', id: initialSelectedId } : null,
  );
  const [deleteTarget, setDeleteTarget] = useState<AiWorkerDTO | null>(null);

  // ── Mutations ───────────────────────────────────────────────────────────────
  // The form builds a FormData and calls action(fd); these wrappers turn it into
  // the JSON the endpoints want. Errors thrown here are caught by the form's
  // submit (which renders + toasts them), so no onError toast on the mutations.
  const createMutation = useMutation({
    mutationFn: (body: ReturnType<typeof buildWorkerBody>) =>
      apiSend<{ worker: AiWorkerDTO }>('/api/ai-workers', 'POST', body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['ai-workers'] });
      setSel({ mode: 'edit', id: res.worker.id });
    },
  });
  const updateMutation = useMutation({
    mutationFn: async (vars: { id: string; body: ReturnType<typeof buildWorkerBody> }) => {
      await apiSend(`/api/ai-workers/${vars.id}`, 'PATCH', vars.body);
      // isDefault is its own atomic endpoint (PATCH ignores it).
      if (vars.body.isDefault) await apiSend(`/api/ai-workers/${vars.id}/default`, 'POST');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-workers'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend(`/api/ai-workers/${id}`, 'DELETE'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-workers'] });
      setSel(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed.'),
  });

  const createAction = (fd: FormData) =>
    createMutation.mutateAsync(buildWorkerBody(fd)).then(() => {});
  const updateAction = (id: string, fd: FormData) =>
    updateMutation.mutateAsync({ id, body: buildWorkerBody(fd) });

  // After a create (?selected=newId deep-link) preselect that worker. The
  // param also accepts a worker KIND (?selected=summarizer / extractor / tts…)
  // — what the assistant links, since no tool lists worker ids — resolving to
  // the default worker of that kind (else the first) once the list arrives.
  // One-shot: workers refetch after every save, and re-resolving then would
  // stomp whatever the operator selected since.
  const deepLinkDoneRef = useRef(false);
  useEffect(() => {
    if (!initialSelectedId || deepLinkDoneRef.current) return;
    const byId = workers.find((w) => w.id === initialSelectedId);
    if (byId) {
      deepLinkDoneRef.current = true;
      setSel({ mode: 'edit', id: byId.id });
      return;
    }
    if (workers.length === 0) return; // list not in yet — try again when it is
    const ofKind = workers.filter((w) => w.kind === initialSelectedId);
    const hit = ofKind.find((w) => w.isDefault) ?? ofKind[0];
    deepLinkDoneRef.current = true;
    if (hit) setSel({ mode: 'edit', id: hit.id });
  }, [initialSelectedId, workers]);

  // Re-derive the edited worker from fresh query data so saves reflect immediately.
  const editWorker = sel?.mode === 'edit' ? (workers.find((w) => w.id === sel.id) ?? null) : null;
  const selectedId = sel?.mode === 'edit' ? sel.id : null;

  // Enabled / default-for-kind are header switches; reset on selection change
  // and inject into the form's submit (see WorkerForm).
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const selKey =
    sel?.mode === 'edit'
      ? `edit:${sel.id}`
      : sel?.mode === 'create'
        ? `create:${sel.kind}`
        : 'none';
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
    deleteMutation.mutate(id);
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
          {workersQuery.isPending ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted-foreground">
              <Spinner size={28} />
              Loading workers…
            </div>
          ) : workersQuery.isError ? (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
              <p>Couldn’t load workers: {workersQuery.error.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => workersQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            KIND_ORDER.map((kind) => {
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
                            'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                            selected && 'border-l-primary',
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
            })
          )}
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
              nativeDocProviders={nativeDocProviders}
              tailnetPeers={tailnetPeers}
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
              nativeDocProviders={nativeDocProviders}
              tailnetPeers={tailnetPeers}
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
