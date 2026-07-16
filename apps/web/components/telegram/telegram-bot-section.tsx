'use client';

/**
 * Telegram bot binding for a responder/assistant agent — shared between the
 * `/settings/agents` editor and the onboarding wizard's Telegram step, so both
 * surfaces drive the *same* connect → pair → manage flow against the same API
 * (`/api/agents/[id]/telegram` + `/telegram/chats`).
 *
 * Loads the agent's currently-linked bot (if any) and lets the operator paste a
 * token to connect / rotate, approve or block a pending pairing request (a DM to
 * the bot), or disconnect. The token is validated (getMe) + sealed server-side;
 * only the bot @username + poll status come back here. Polls every 10s so a
 * fresh DM's pairing request appears without a manual refresh.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import type { AgentTelegramBinding, AgentTelegramChat } from '@/lib/agent-telegram';

export function TelegramBotSection({ agentId }: { agentId: string }) {
  const toast = useToast();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  // undefined = loading, null = not linked.
  const [binding, setBinding] = useState<AgentTelegramBinding | null | undefined>(undefined);
  const [chats, setChats] = useState<AgentTelegramChat[]>([]);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyChat, setBusyChat] = useState<string | null>(null);

  // `initial` shows the loading state + flips to null on failure; polled
  // refreshes update in place without flashing.
  const load = useCallback(
    async (initial = false) => {
      if (initial) setBinding(undefined);
      try {
        const b = await apiFetch<{
          binding?: AgentTelegramBinding | null;
          chats?: AgentTelegramChat[];
        }>(`/api/agents/${agentId}/telegram`);
        setBinding(b.binding ?? null);
        setChats(b.chats ?? []);
      } catch {
        if (initial) setBinding(null);
      }
    },
    [agentId],
  );

  useEffect(() => {
    setToken('');
    void load(true);
    // Poll so a fresh DM's pairing request shows up without a manual refresh.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    let b: { binding?: AgentTelegramBinding };
    try {
      b = await apiSend<{ binding?: AgentTelegramBinding }>(
        `/api/agents/${agentId}/telegram`,
        'POST',
        {
          token: token.trim(),
        },
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not link the bot.');
      return;
    } finally {
      setBusy(false);
    }
    if (!b.binding) {
      toast.error('Could not link the bot.');
      return;
    }
    setToken('');
    toast.success(`Linked @${b.binding.botUsername}`);
    void load();
    startRefresh(() => router.refresh());
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await apiSend(`/api/agents/${agentId}/telegram`, 'DELETE');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not unlink the bot.');
      return;
    } finally {
      setBusy(false);
    }
    setBinding(null);
    setChats([]);
    setToken('');
    toast.success('Bot unlinked');
    startRefresh(() => router.refresh());
  };

  const setChatStatus = async (chatId: string, status: 'allowed' | 'denied') => {
    setBusyChat(chatId);
    try {
      await apiSend(`/api/agents/${agentId}/telegram/chats`, 'POST', { chatId, status });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not update the chat.');
      return;
    } finally {
      setBusyChat(null);
    }
    toast.success(status === 'allowed' ? 'Paired' : 'Blocked');
    void load();
  };

  if (binding === undefined) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading…
      </div>
    );
  }

  const pending = chats.filter((c) => c.status === 'pending');
  const allowedCount = chats.filter((c) => c.status === 'allowed').length;

  return (
    <div className="space-y-2">
      {binding && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
            <Send className="size-3.5" aria-hidden />@{binding.botUsername}
          </span>
          {binding.enabled ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> polling
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">disabled</span>
          )}
          {allowedCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {allowedCount} paired chat{allowedCount === 1 ? '' : 's'}
            </span>
          )}
          {binding.lastPollError && (
            <span className="truncate text-xs text-destructive" title={binding.lastPollError}>
              {binding.lastPollError}
            </span>
          )}
        </div>
      )}

      {/* Pending pairing requests — approve a DM without copying a code. */}
      {pending.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Pairing request{pending.length === 1 ? '' : 's'} — someone DM&apos;d this bot
          </p>
          {pending.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {c.label}{' '}
                <code className="text-[11px] text-muted-foreground">{c.telegramChatId}</code>
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => setChatStatus(c.id, 'allowed')}
                disabled={busyChat === c.id}
              >
                {busyChat === c.id && <Loader2 className="animate-spin" aria-hidden />}
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setChatStatus(c.id, 'denied')}
                disabled={busyChat === c.id}
              >
                Block
              </Button>
            </div>
          ))}
        </div>
      )}

      <input
        type="text"
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void connect();
          }
        }}
        placeholder={binding ? 'Paste a new token to rotate…' : 'Paste your bot token…'}
        className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={connect} disabled={busy || !token.trim()}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {binding ? 'Update token' : 'Connect bot'}
        </Button>
        {binding && (
          <Button type="button" size="sm" variant="outline" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}
