import Link from 'next/link';
import { Plus, Cog, CheckCircle2, Circle } from 'lucide-react';
import type { AiWorkerKind } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { listAiWorkers } from '@/lib/ai-workers';
import { formatDateTime } from '@/lib/format-datetime';
import { Button } from '@/components/ui/button';

/** Display metadata per kind — the title in the section header, the
 *  one-liner under it, and the icon hint. */
const KIND_META: Record<
  AiWorkerKind,
  { label: string; description: string }
> = {
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
    description:
      'Rolls Telegram conversations into topic-based digests (Tier-2 memory).',
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
  image_gen: {
    label: 'Image generation',
    description: 'Text → image. Reserved for future tooling.',
  },
};

const KIND_ORDER: AiWorkerKind[] = [
  'tts',
  'stt',
  'vision',
  'extractor',
  'summarizer',
  'reflector',
  'image_gen',
];

export default async function AiWorkersPage() {
  const user = await requireOwner();
  const workers = await listAiWorkers(user.id);
  const byKind = new Map<AiWorkerKind, typeof workers>();
  for (const k of KIND_ORDER) byKind.set(k, []);
  for (const w of workers) {
    byKind.get(w.kind)?.push(w);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">AI workers</h1>
        <p className="text-sm text-muted-foreground">
          One-shot AI jobs: voice in/out, vision OCR, the background extractor / summarizer /
          reflector. Each worker has its own model, API key, and kind-specific params.
          Conversational agents (responder, assistant) live at{' '}
          <Link href="/settings/agents" className="underline">
            /settings/agents
          </Link>{' '}
          — different abstraction.
        </p>
      </header>

      {KIND_ORDER.map((kind) => {
        const meta = KIND_META[kind];
        const items = byKind.get(kind) ?? [];
        return (
          <section key={kind} className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <div className="space-y-0.5">
                <h2 className="text-lg font-semibold">{meta.label}</h2>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/settings/ai-workers/new?kind=${kind}`}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add
                </Link>
              </Button>
            </div>

            {items.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                No {meta.label.toLowerCase()} configured.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {items.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 text-sm">
                        {w.isDefault ? (
                          <span title="Default for this kind">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          </span>
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground/40" />
                        )}
                        <span className="font-medium">{w.name}</span>
                        {!w.enabled && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            disabled
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <code className="rounded bg-muted px-1.5 py-0.5">{w.slug}</code>
                        <span>{w.provider}</span>
                        <span>{w.model}</span>
                        {w.lastUsedAt && <span>last used {formatDateTime(w.lastUsedAt)}</span>}
                        <span>{w.usageCount} runs</span>
                      </div>
                    </div>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/settings/ai-workers/${w.id}`}>
                        <Cog className="mr-1 h-3.5 w-3.5" />
                        Configure
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
