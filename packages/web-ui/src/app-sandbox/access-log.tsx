'use client';

/**
 * Read-only viewer for a shared app's external access log (the app_access_log
 * rows the /s/ brokers write). Shows who (a team member, or "Anonymous" for a
 * public visitor), what (paired / used a tool / ran a query), and when.
 */
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Wrench, Database, UserRound } from 'lucide-react';
import { apiFetch } from '../api-fetch';
import { Spinner } from '../ui/spinner';
import { formatDateTime } from '../lib/format-datetime';

type AccessKind = 'auth' | 'tool' | 'db';
type AccessEntry = {
  id: string;
  contactId: string | null;
  contactName: string | null;
  kind: AccessKind;
  detail: Record<string, unknown>;
  createdAt: string;
};

function describe(e: AccessEntry): { icon: typeof KeyRound; label: string } {
  switch (e.kind) {
    case 'auth':
      return { icon: KeyRound, label: 'Entered their team token' };
    case 'tool':
      return {
        icon: Wrench,
        label: `Used tool ${typeof e.detail.slug === 'string' ? e.detail.slug : ''}`.trim(),
      };
    case 'db':
      return {
        icon: Database,
        label: e.detail.op === 'exec' ? 'Wrote to the app database' : 'Queried the app database',
      };
  }
}

export function AppAccessLog({ appId }: { appId: string }) {
  const q = useQuery({
    queryKey: ['apps', appId, 'access-log'],
    queryFn: () => apiFetch<{ entries: AccessEntry[] }>(`/api/apps/${appId}/access-log`),
  });

  if (q.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">Couldn’t load activity.</div>
    );
  }
  const entries = q.data.entries;
  if (entries.length === 0) {
    return (
      <div className="mx-auto max-w-md p-8 text-center text-sm text-muted-foreground">
        No external activity yet. When you share this app and someone opens it, their actions (token
        entry, tool calls, database access) show up here.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {entries.map((e) => {
          const { icon: Icon, label } = describe(e);
          const who =
            e.contactName ?? (e.contactId ? 'Removed contact' : 'Anonymous (public link)');
          return (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <span className="truncate">{label}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <UserRound className="size-3 shrink-0" aria-hidden />
                  {who}
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {formatDateTime(e.createdAt)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
