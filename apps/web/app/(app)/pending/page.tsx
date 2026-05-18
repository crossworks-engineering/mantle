import Link from 'next/link';
import { listPendingCalls } from '@mantle/tools';
import { requireOwner } from '@/lib/auth';
import { PendingClient } from './pending-client';

export default async function PendingPage() {
  const user = await requireOwner();
  const rows = await listPendingCalls(user.id, { limit: 200 });

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Pending approvals</h1>
        <p className="text-sm text-muted-foreground">
          Tool calls an agent proposed but didn&apos;t auto-run because the tool is
          marked <em>requires confirm</em>. Approve to execute; reject to drop. Each
          approval runs the tool under a fresh <code>manual</code> trace —{' '}
          <Link href="/traces" className="underline">/traces</Link> shows the result.
        </p>
      </header>
      <PendingClient initialRows={rows} />
    </div>
  );
}
