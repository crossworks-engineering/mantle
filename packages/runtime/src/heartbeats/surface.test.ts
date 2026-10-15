/**
 * heartbeatSurface is the inline surface of fire.ts's runToolLoop call,
 * moved (A8 fix round 4) with no change in behaviour: over every input it
 * answers what the old expression answered, and the answers the A8 surface
 * cells send are pinned.
 */
import { describe, expect, it } from 'vitest';
import { heartbeatSurface } from './surface';

/** fire.ts's expression before the move, verbatim. */
function oldSurface(
  scoped: boolean,
  adminAssistant: boolean,
  telegramChat: string | null,
  pairedTelegram: { accountId: string } | null,
) {
  return scoped && !adminAssistant
    ? { kind: 'team', privateReads: false }
    : telegramChat && pairedTelegram
      ? {
          kind: 'telegram',
          telegramChatId: telegramChat,
          // The chat's own bot (W7d fix round 1, L7).
          accountId: pairedTelegram.accountId,
        }
      : { kind: 'web' };
}

describe('heartbeatSurface', () => {
  it('answers what the old inline expression answered, over every input', () => {
    let n = 0;
    for (const scoped of [false, true])
      for (const adminAssistant of [false, true])
        for (const telegramChat of [null, '', '4711'])
          for (const pairedTelegram of [null, { accountId: 'acct-1' }]) {
            expect(
              heartbeatSurface({ scoped, adminAssistant, telegramChat, pairedTelegram }),
              JSON.stringify({ scoped, adminAssistant, telegramChat, pairedTelegram }),
            ).toEqual(oldSurface(scoped, adminAssistant, telegramChat, pairedTelegram));
            n++;
          }
    expect(n).toBe(24);
  });

  it('a workspace assistant fires on a team surface with no login; the Admin assistant on web', () => {
    const none = { telegramChat: null, pairedTelegram: null };
    expect(heartbeatSurface({ scoped: true, adminAssistant: false, ...none })).toEqual({
      kind: 'team',
      privateReads: false,
    });
    expect(heartbeatSurface({ scoped: true, adminAssistant: true, ...none })).toEqual({
      kind: 'web',
    });
    expect(
      heartbeatSurface({
        scoped: true,
        adminAssistant: true,
        telegramChat: '4711',
        pairedTelegram: { accountId: 'acct-1' },
      }),
    ).toEqual({ kind: 'telegram', telegramChatId: '4711', accountId: 'acct-1' });
  });
});
