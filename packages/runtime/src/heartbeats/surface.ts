/**
 * The surface a heartbeat's turn names (fire.ts, the runToolLoop call in
 * fireAs), as one pure function so a test can ask it (the surface matrix
 * cells send what it answers).
 */
import type { ToolHandlerContext } from '@mantle/tools';

export type HeartbeatSurface = NonNullable<ToolHandlerContext['surface']>;

/** A workspace assistant's fire is not the owner's channel: a team surface
 *  with no login (read only, private reads off). Otherwise the chat the
 *  heartbeat names when it is paired to the login the fire answers (its own
 *  bot), else the owner's web surface. */
export function heartbeatSurface(o: {
  scoped: boolean;
  adminAssistant: boolean;
  telegramChat: string | null;
  pairedTelegram: { accountId: string } | null;
}): HeartbeatSurface {
  return o.scoped && !o.adminAssistant
    ? { kind: 'team', privateReads: false }
    : o.telegramChat && o.pairedTelegram
      ? {
          kind: 'telegram',
          telegramChatId: o.telegramChat,
          // The chat's own bot.
          accountId: o.pairedTelegram.accountId,
        }
      : { kind: 'web' };
}
