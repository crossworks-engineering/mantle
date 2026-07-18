'use client';

/**
 * The /team landing inside the workspace shell: a greeting plus one tile per
 * section with its share count. Everything here is DERIVED from the shares —
 * no curation, no hand-written hub content (that era lives on at /hub for
 * brains with a designated hub app).
 */
import Link from 'next/link';
import { StartTopicComposer } from '@/components/team-forum/start-topic-composer';
import { useWorkspace, WORKSPACE_NAV } from './team-workspace-shell';

export function TeamOverview() {
  const data = useWorkspace();
  if (!data) return null;
  const firstName = data.memberName?.split(/\s+/)[0] ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          {firstName ? `Welcome, ${firstName}.` : 'Welcome.'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything {data.siteName || 'this brain'} shares with the team, always current. Ask
          something below to start a forum topic, or browse a section.
        </p>

        <div className="mt-6">
          <StartTopicComposer />
        </div>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {/* Sections only — the Dashboard nav entry IS this screen. */}
          {WORKSPACE_NAV.filter((item) => item.type !== 'dashboard').map((item) => {
            const count = data.counts[item.type] ?? 0;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
              >
                <Icon className="size-5 text-muted-foreground" aria-hidden />
                <p className="mt-2 text-sm font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {count} shared item{count === 1 ? '' : 's'}
                </p>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
