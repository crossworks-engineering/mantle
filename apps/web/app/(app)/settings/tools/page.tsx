import { requireOwner } from '@/lib/auth';
import { listToolsForOwner } from '@/lib/tools';
import { ToolsClient } from './tools-client';

export default async function ToolsPage() {
  const user = await requireOwner();
  const rows = await listToolsForOwner(user.id);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Tools</h1>
        <p className="text-sm text-muted-foreground">
          Every callable an agent can invoke during a turn. <strong>Built-in</strong>{' '}
          tools are TS handlers seeded by the agent runner on boot; their definitions
          live in <code>packages/tools/src/builtins.ts</code> and edits require a
          restart. <strong>HTTP</strong> + <strong>shell</strong> tools are user-defined
          here.
        </p>
        <p className="text-xs text-muted-foreground">
          Tools marked <em>requires confirm</em> don&apos;t auto-execute. The agent
          queues each requested call at <a href="/pending" className="underline">/pending</a>{' '}
          for you to approve or reject.
        </p>
      </header>
      <ToolsClient initialTools={rows} />
    </div>
  );
}
