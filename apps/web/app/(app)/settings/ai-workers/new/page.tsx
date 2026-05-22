import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { AiWorkerKind } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { listApiKeys } from '@/lib/api-keys';
import { Button } from '@/components/ui/button';
import { SetPageTitle } from '@/components/layout/page-title';
import { WorkerForm } from '../worker-form';
import { createAiWorkerAction } from '../actions';

const VALID_KINDS: AiWorkerKind[] = [
  'tts',
  'stt',
  'vision',
  'image_gen',
  'reflector',
  'extractor',
  'summarizer',
];

const KIND_LABELS: Record<AiWorkerKind, string> = {
  tts: 'TTS (voice out)',
  stt: 'STT (voice in)',
  vision: 'Vision',
  image_gen: 'Image generation',
  reflector: 'Reflector',
  extractor: 'Extractor',
  summarizer: 'Summarizer',
};

export default async function NewAiWorkerPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const user = await requireOwner();
  const { kind: kindParam } = await searchParams;
  const kind = kindParam as AiWorkerKind | undefined;
  if (!kind || !VALID_KINDS.includes(kind)) {
    notFound();
  }

  const keys = await listApiKeys(user.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title={`New ${KIND_LABELS[kind]} worker`} />
      <header className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/settings/ai-workers">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            Back
          </Link>
        </Button>
      </header>

      <WorkerForm
        mode="create"
        kind={kind}
        keys={keys.map((k) => ({
          id: k.id,
          service: k.service,
          label: k.label,
          masked: k.masked,
        }))}
        action={createAiWorkerAction}
      />
    </div>
  );
}
