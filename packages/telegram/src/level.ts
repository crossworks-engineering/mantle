/**
 * Only an admin-level agent answers on Telegram (access matrix T21, option 3).
 *
 * A paired Telegram chat is the owner: its turns run on the `telegram`
 * surface, which `isOwnerSurface` (packages/tools/src/surface.ts) counts as
 * the owner. On a team, client or public agent's bot that would hand whoever
 * is paired the owner's authority. So such a bot is never paired, its chats
 * get no turn (an agent lowered after pairing included), no bot is linked to
 * such an agent, and an agent that has a bot or answers a paired chat is not
 * lowered (setAgentAudience).
 *
 * Pure on purpose, and exported as `@mantle/telegram/level` beside the main
 * entry: a test that fakes the whole transport keeps these real.
 */

/** The `code` an API refusal carries, so a screen can tell this refusal
 *  (a standing condition, not a transient failure) from the rest. */
export const TELEGRAM_LEVEL_CODE = 'agent_below_admin';

/** An agent as these rules read it. */
export type TelegramLevelAgent = { name: string; audience: string };

/**
 * Whether an agent is below admin. A row always carries a level (CHECK and
 * default); a stand-in with none counts as admin, as `agentLevel` does. Any
 * other value is below admin, so an unknown one fails closed.
 */
export function isBelowAdminAgent(agent: { audience?: string | null }): boolean {
  return agent.audience != null && agent.audience !== 'admin';
}

/** Why a chat on a below-admin agent's bot cannot be paired. */
export function telegramPairRefusal(agent: TelegramLevelAgent): string {
  return (
    `${agent.name} is a ${agent.audience}-level agent. Only an admin-level agent's bot ` +
    'can be paired, because a paired Telegram chat acts as the owner. ' +
    `Raise ${agent.name} to admin first, or block this chat.`
  );
}

/** Why a bot cannot be linked to a below-admin agent. */
export function telegramConnectRefusal(agent: TelegramLevelAgent): string {
  return (
    `${agent.name} is a ${agent.audience}-level agent. Only an admin-level agent can ` +
    'have a Telegram bot, because a paired Telegram chat acts as the owner. ' +
    `Raise ${agent.name} to admin first, or link the bot to an admin-level agent.`
  );
}

/** Why a chat cannot be handed to a below-admin agent. */
export function telegramResponderRefusal(agent: TelegramLevelAgent): string {
  return (
    `${agent.name} is a ${agent.audience}-level agent. Only an admin-level agent can ` +
    'answer a Telegram chat, because a paired Telegram chat acts as the owner.'
  );
}

/** The one reply a chat gets when its agent is below admin. Plain and
 *  short: the person reading it may not be the owner. */
export const TELEGRAM_BELOW_ADMIN_REPLY =
  'This chat is turned off: only an admin-level agent answers on Telegram. Ask the owner.';
