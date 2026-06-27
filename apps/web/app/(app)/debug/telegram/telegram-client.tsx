'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { ChatAgentOverride } from '../chat-agent-override';
import { fmtRelative } from '../format';
import type { AgentActivityRow, ChatRow } from '@/lib/debug';

const PAGE_SIZE = 50;

type TelegramData = { chats: ChatRow[]; total: number; agents: AgentActivityRow[] };

/** Data-free Telegram chats list: fetches GET /api/debug/telegram keyed on the
 *  URL's page/q (DebugSearchBox + DebugPager drive the URL). */
export function TelegramClient({ page, query }: { page: number; query: string }) {
  const telegramQuery = useQuery({
    queryKey: ['debug', 'telegram', { page, query }],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page) });
      if (query) p.set('q', query);
      return apiFetch<TelegramData>(`/api/debug/telegram?${p.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  const chats = telegramQuery.data?.chats ?? [];
  const agents = telegramQuery.data?.agents ?? [];
  const total = telegramQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Telegram chats
        </h2>
        <DebugSearchBox placeholder="Search chats…" />
      </div>

      {telegramQuery.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : telegramQuery.isError ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          Couldn&apos;t load Telegram chats.
        </p>
      ) : chats.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          {query ? 'No chats match your search.' : 'No Telegram chats yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Chat</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Agent</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 text-right font-semibold">Digested</th>
                <th className="px-3 py-2 text-right font-semibold">Pending</th>
                <th className="px-3 py-2 text-left font-semibold">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {chats.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <span className="font-medium">{c.title ?? c.username ?? '(unnamed)'}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.telegramChatId}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        c.allowlistStatus === 'allowed'
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : c.allowlistStatus === 'denied'
                            ? 'text-destructive'
                            : 'text-amber-700 dark:text-amber-300'
                      }
                    >
                      {c.allowlistStatus}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <ChatAgentOverride chatId={c.id} current={c.responderAgentId} agents={agents} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.totalTurns}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {c.digested}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={
                        c.undigested >= 30 ? 'font-semibold text-amber-700 dark:text-amber-300' : ''
                      }
                    >
                      {c.undigested}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {c.lastActivity ? fmtRelative(c.lastActivity) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DebugPager page={page} totalPages={totalPages} total={total} />

      <p className="text-xs text-muted-foreground">
        <strong>Pending</strong> is the count of turns not yet folded into a digest. A chat with
        pending ≥ 30 (the default summarizer threshold) is about to roll up on the next message.{' '}
        <strong>Agent</strong> pins a specific responder to this chat; <em>default</em> falls back to
        the global highest-priority enabled responder.
      </p>
    </>
  );
}
