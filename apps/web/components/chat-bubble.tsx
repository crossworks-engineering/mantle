'use client';

/**
 * Universal chat bubble for the in-surface specialist Assist panels (Pages,
 * Tables, Apps, Dev-tools). One text size + bubble treatment everywhere, so an
 * agent's reply reads the same in every chat instead of each panel hand-rolling
 * its own (Apps was text-xs, the rest text-sm, with three different bubble
 * looks). Mirrors the main /assistant dock's treatment — primary for the user,
 * a bordered surface for the agent — so the specialist chats match the app's
 * primary chat.
 */

import type { ReactNode } from 'react';
import { cn } from '@mantle/web-ui/lib/utils';

/** The universal message text size for every specialist chat. Bumped up from the
 *  old text-xs/text-sm mix for readability; keep all bubbles on this. */
export const CHAT_TEXT_CLASS = 'text-[15px] leading-relaxed';

export function ChatBubble({
  role,
  agentName,
  children,
  className,
}: {
  role: 'user' | 'assistant';
  /** Small label above an assistant reply (e.g. "Ledger", "Appsmith"). */
  agentName?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-lg px-3 py-2',
        role === 'user'
          ? 'bg-primary text-primary-foreground'
          : 'border border-border bg-background text-foreground',
        className,
      )}
    >
      {role === 'assistant' && agentName && (
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {agentName}
        </div>
      )}
      <div className={cn('whitespace-pre-wrap', CHAT_TEXT_CLASS)}>{children}</div>
    </div>
  );
}
