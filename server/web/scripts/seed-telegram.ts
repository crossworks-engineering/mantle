/**
 * Idempotent seed for an existing Telegram bot setup.
 *
 * Migrates the user's prior `~/.claude/channels/telegram/` state — the
 * bot token in `.env` and the allowFrom list in `access.json` — into the
 * Mantle DB. Re-running updates rather than duplicates.
 *
 * Usage:
 *   cd apps/web && node --env-file=./.env.local --import tsx \
 *     scripts/seed-telegram.ts [--legacy-state-dir=PATH]
 *
 * Required env: DATABASE_URL, MANTLE_MASTER_KEY, ALLOWED_USER_ID.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { agents, db, telegramAccounts, telegramChats } from '@mantle/db';
import { upsertTelegramChannel } from '@mantle/telegram';

if (!process.env.ALLOWED_USER_ID) {
  console.error('ALLOWED_USER_ID must be set.');
  process.exit(1);
}
if (!process.env.MANTLE_MASTER_KEY) {
  console.error('MANTLE_MASTER_KEY must be set.');
  process.exit(1);
}
const ownerId: string = process.env.ALLOWED_USER_ID;

const legacyArg = process.argv.find((a) => a.startsWith('--legacy-state-dir='));
const legacyDir = legacyArg
  ? legacyArg.split('=')[1]!
  : join(homedir(), '.claude', 'channels', 'telegram');

async function main() {
  const token = readToken(legacyDir);
  const allowFrom = readAllowFrom(legacyDir);

  const me = await getMe(token);
  console.log(`Discovered bot @${me.username} (id ${me.id})`);

  // A channel must carry an agent (docs/comms-channels.md), so attach the bot
  // to the highest-priority enabled conversational agent.
  const [target] = await db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, ['assistant', 'responder', 'custom']),
      ),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  if (!target) {
    throw new Error(
      'No enabled conversational agent to attach the bot to — create one at /settings/agents first.',
    );
  }

  // Upsert telegram_accounts (poll-state extension; the token lives on the channel).
  const existing = await db
    .select()
    .from(telegramAccounts)
    .where(eq(telegramAccounts.botUsername, me.username))
    .limit(1);

  const branchPath = `inbox.telegram_${me.username.toLowerCase()}`;

  let accountId: string;
  if (existing[0]) {
    await db
      .update(telegramAccounts)
      .set({ branchPath, enabled: true, updatedAt: new Date() })
      .where(eq(telegramAccounts.id, existing[0].id));
    accountId = existing[0].id;
    console.log(`  updated existing account ${accountId}`);
  } else {
    const [inserted] = await db
      .insert(telegramAccounts)
      .values({
        userId: ownerId,
        botUsername: me.username,
        branchPath,
        enabled: true,
      })
      .returning({ id: telegramAccounts.id });
    accountId = inserted!.id;
    console.log(`  created account ${accountId}`);
  }

  // The token + agent binding live on the channel (sealed under the channel id).
  await upsertTelegramChannel({
    ownerId,
    agentId: target.id,
    accountId,
    botUsername: me.username,
    branchPath,
    token,
    enabled: true,
  });
  console.log(`  attached @${me.username} to agent '${target.slug}'`);

  // Upsert allowlisted chats. For DMs, chat_id == user_id.
  for (const userId of allowFrom) {
    const chatExisting = await db
      .select()
      .from(telegramChats)
      .where(eq(telegramChats.telegramChatId, userId))
      .limit(1);
    if (chatExisting[0]) {
      await db
        .update(telegramChats)
        .set({
          allowlistStatus: 'allowed',
          pairingCode: null,
          pairingExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(telegramChats.id, chatExisting[0].id));
      console.log(`  marked chat ${userId} as allowed (existing row)`);
    } else {
      await db.insert(telegramChats).values({
        accountId,
        userId: ownerId,
        telegramChatId: userId,
        chatType: 'private',
        allowlistStatus: 'allowed',
      });
      console.log(`  inserted allowlisted chat ${userId}`);
    }
  }

  console.log('\nSeed complete.');
}

function readToken(dir: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(dir, '.env'), 'utf8');
  } catch (err) {
    throw new Error(`could not read ${dir}/.env: ${(err as Error).message}`, { cause: err });
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/);
    if (m) return m[1]!.trim();
  }
  throw new Error(`TELEGRAM_BOT_TOKEN not found in ${dir}/.env`);
}

function readAllowFrom(dir: string): string[] {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'));
    return Array.isArray(json.allowFrom) ? json.allowFrom : [];
  } catch {
    return [];
  }
}

async function getMe(token: string): Promise<{ id: number; username: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  if (!res.ok) throw new Error(`getMe HTTP ${res.status}`);
  const body = (await res.json()) as { ok: boolean; result?: { id: number; username: string } };
  if (!body.ok || !body.result?.username) throw new Error('getMe returned no username');
  return { id: body.result.id, username: body.result.username };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
