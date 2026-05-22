import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
import { getAiWorker } from '@/lib/ai-workers';
import { listApiKeys } from '@/lib/api-keys';
import { Button } from '@/components/ui/button';
import { SetPageTitle } from '@/components/layout/page-title';
import { WorkerForm } from '../worker-form';
import { deleteAiWorkerAction, updateAiWorkerAction } from '../actions';

export default async function EditAiWorkerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireOwner();
  const { id } = await params;
  const worker = await getAiWorker(user.id, id);
  if (!worker) notFound();
  const keys = await listApiKeys(user.id);

  // Action wrapper closes over the id so the form action signature
  // stays `(FormData) => Promise<void>` (matches createAiWorkerAction's
  // shape).
  const updateAction = async (formData: FormData) => {
    'use server';
    await updateAiWorkerAction(id, formData);
  };
  const deleteAction = async () => {
    'use server';
    await deleteAiWorkerAction(id);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title={worker.name} />
      <header className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/settings/ai-workers">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            Back
          </Link>
        </Button>
        <div className="flex items-center justify-between gap-2">
          <form action={deleteAction}>
            <Button type="submit" variant="destructive" size="sm">
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Delete
            </Button>
          </form>
        </div>
        <p className="text-xs text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5">{worker.slug}</code> · kind:{' '}
          {worker.kind} · {worker.usageCount} runs
        </p>
      </header>

      <WorkerForm
        mode="edit"
        kind={worker.kind}
        worker={worker}
        keys={keys.map((k) => ({
          id: k.id,
          service: k.service,
          label: k.label,
          masked: k.masked,
        }))}
        action={updateAction}
      />
    </div>
  );
}
