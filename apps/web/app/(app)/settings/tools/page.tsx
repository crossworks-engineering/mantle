import { and, eq } from 'drizzle-orm';
import { db, tools } from '@mantle/db';
import { requireOwner } from '@/lib/auth';

/**
 * Read-only browse of the tool registry — built-ins seeded by the
 * agent on boot + (eventually) user-defined HTTP / shell tools.
 *
 * Editing / adding tools comes in a later phase; this is the discovery
 * surface so you can see what's available and copy slugs into an
 * agent's tool allowlist.
 */
export default async function ToolsPage() {
  const user = await requireOwner();
  const rows = await db
    .select()
    .from(tools)
    .where(eq(tools.ownerId, user.id))
    .orderBy(tools.slug);

  const builtins = rows.filter((r) => (r.handler as { kind: string }).kind === 'builtin');
  const http = rows.filter((r) => (r.handler as { kind: string }).kind === 'http');
  const shell = rows.filter((r) => (r.handler as { kind: string }).kind === 'shell');
  // Mark unused vars defensively in case the user has zero of a kind.
  void and;

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <header>
        <h1 className="text-lg font-semibold">Tools</h1>
        <p className="text-xs text-muted-foreground">
          Every tool an agent could call. Attach specific tools to specific agents
          on <a href="/settings/agents" className="underline">/settings/agents</a>.
          Built-ins are seeded automatically by the agent runner on boot.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          No tools yet. Start <code>pnpm dev</code> and the agent will seed the
          built-in catalog on boot.
        </p>
      ) : (
        <ToolSection title="Built-in" rows={builtins} note="Pure TS handlers shipped with Mantle. Always safe to attach to any agent." />
      )}
      {http.length > 0 && (
        <ToolSection title="HTTP" rows={http} note="User-registered HTTP tools (URL + JSON schema). Subject to network + auth handling." />
      )}
      {shell.length > 0 && (
        <ToolSection title="Shell" rows={shell} note="Shell-command tools. Always require operator confirmation before running." />
      )}
    </div>
  );
}

function ToolSection({
  title,
  rows,
  note,
}: {
  title: string;
  rows: Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    requiresConfirm: boolean;
    enabled: boolean;
  }>;
  note: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <span className="text-xs text-muted-foreground">{rows.length} tools</span>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {rows.map((t) => (
          <li key={t.id} className="px-3 py-2 text-sm">
            <div className="flex items-baseline gap-2">
              <code className="font-mono font-medium">{t.slug}</code>
              <span className="text-xs text-muted-foreground">{t.name}</span>
              {!t.enabled && (
                <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                  disabled
                </span>
              )}
              {t.requiresConfirm && (
                <span className="rounded-sm bg-rose-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
                  requires confirm
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
