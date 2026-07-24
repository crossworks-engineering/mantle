'use client';

import { Bot, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { TagPill } from '@mantle/web-ui/tag-pill';
import { fmtRelative } from '../format';
import type { AgentActivityRow, PersonaNotesRow } from '@/lib/debug';

type AgentsData = { agents: AgentActivityRow[]; personaNotes: PersonaNotesRow[] };

/** Data-free agents debug view: fetches GET /api/debug/agents. */
export function AgentsClient() {
  const agentsQuery = useQuery({
    queryKey: ['debug', 'agents'],
    queryFn: () => apiFetch<AgentsData>('/api/debug/agents'),
  });

  if (agentsQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (agentsQuery.isError && !agentsQuery.data) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        Couldn&apos;t load agents.
      </p>
    );
  }

  const { agents, personaNotes } = agentsQuery.data;

  return (
    <>
      {/* ─── Agent activity ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Agent activity
        </h2>
        {agents.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No agents configured. Set one up at{' '}
            <a href="/settings/agents" className="underline">
              /settings/agents
            </a>
            .
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Agent</th>
                  <th className="px-3 py-2 text-left font-semibold">Role</th>
                  <th className="px-3 py-2 text-left font-semibold">Model</th>
                  <th className="px-3 py-2 text-right font-semibold">Priority</th>
                  <th className="px-3 py-2 text-right font-semibold">Runs</th>
                  <th className="px-3 py-2 text-left font-semibold">Last used</th>
                  <th className="px-3 py-2 text-left font-semibold">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2">
                      <div className="flex flex-col">
                        <span className="font-medium">{a.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{a.slug}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-wider">
                        {a.role}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <code className="font-mono text-xs">{a.model}</code>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.priority}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.usageCount}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {a.lastUsedAt ? fmtRelative(a.lastUsedAt) : 'never'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {a.enabled ? (
                        <span className="text-emerald-700 dark:text-emerald-300">enabled</span>
                      ) : (
                        <span className="text-muted-foreground">disabled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Persona notes ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Persona notes
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          What the reflector has learned about how to respond — observed from dialog every few
          minutes and fed back into the responder&apos;s prompt.
        </p>

        {personaNotes.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No persona notes yet. Set up a <code>reflector</code> agent at{' '}
            <a href="/settings/agents" className="underline">
              /settings/agents
            </a>{' '}
            and it will start observing dialog signals.
          </p>
        ) : (
          <div className="space-y-4">
            {personaNotes.map((p) => (
              <div key={p.agentId} className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Bot className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-sm font-medium">{p.agentName}</span>
                    <code className="font-mono text-xs text-muted-foreground">{p.agentSlug}</code>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {p.notes.length} note{p.notes.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="divide-y divide-border">
                  {p.notes.map((n, i) => (
                    <li key={i} className="flex items-start gap-3 px-4 py-2.5">
                      <TagPill tag={n.kind} className="mt-0.5 shrink-0 capitalize" />
                      <p className="min-w-0 flex-1 text-sm">{n.content}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fmtRelative(n.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
