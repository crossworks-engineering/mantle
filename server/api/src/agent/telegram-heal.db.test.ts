/**
 * The Telegram drain's self-heal (healRepliedTelegramMessages) on a real
 * migrated Postgres: an inbound row with an outbound reply that was never
 * marked processed is flipped to processed (its processed_at kept when
 * set, else now()); nothing else moves. The same rows as the statement's
 * raw text (the reference below), run first and rolled back.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/telegram-heal.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The heal as raw text, the reference the typed write must equal. */
const REFERENCE = `
  update telegram_messages m
     set processed = true, processed_at = coalesce(m.processed_at, now())
   where m.processed = false
     and m.direction = 'inbound'
     and exists (
       select 1 from telegram_messages r
        where r.reply_to_id = m.id
          and r.direction = 'outbound'
     )
  returning m.id::text as id`;

describe.skipIf(!URL)('healRepliedTelegramMessages', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  const owner = randomUUID();
  const agent = randomUUID();
  const channel = randomUUID();
  const account = randomUUID();
  const chat = randomUUID();
  const tag = `tgh${randomUUID().slice(0, 6)}`;
  const OLD = '2020-01-02T03:04:05.000Z';
  const row: Record<string, string> = {};
  let seq = 0;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  const message = async (
    name: string,
    direction: 'inbound' | 'outbound',
    opts: { processed?: boolean; processedAt?: string | null; replyTo?: string } = {},
  ): Promise<void> => {
    seq += 1;
    const [node] = await x<{ id: string }>(sql`insert into nodes (owner_id, type, title, path)
      values (${owner}, 'telegram_message', ${`${tag} ${name}`}, 'inbox.telegram_test')
      returning id::text`);
    const [msg] = await x<{ id: string }>(sql`insert into telegram_messages
        (node_id, account_id, chat_id, telegram_message_id, telegram_update_id, text, sent_at,
         direction, processed, processed_at, reply_to_id)
      values (${node!.id}, ${account}, ${chat}, ${String(seq)},
              ${direction === 'inbound' ? seq : null}, ${name}, now(), ${direction},
              ${opts.processed ?? false}, ${opts.processedAt ?? null}::timestamptz,
              ${opts.replyTo ?? null}::uuid)
      returning id::text`);
    row[name] = msg!.id;
  };

  const state = async () =>
    x<{ id: string; processed: boolean; processed_at: string | null }>(sql`
      select id::text, processed, processed_at::text from telegram_messages
       where account_id = ${account} order by id`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.ALLOWED_USER_ID = owner;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    const [ws] = await x<{ id: string }>(sql`select id::text from workspaces
      where owner_id = ${owner} and is_admin and archived_at is null`);
    await x(sql`insert into agents (id, owner_id, slug, name, provider, model, system_prompt,
                                    role, workspace_id, tool_group_slugs)
      values (${agent}, ${owner}, ${tag}, ${tag}, 'local', 'fake/model', 'p', 'responder',
              ${ws!.id}, '{}')`);
    await x(sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
      values (${channel}, ${owner}, ${agent}, 'telegram', ${`@${tag}`}, '\\x00')`);
    await x(sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
      values (${account}, ${owner}, ${tag}, 'inbox.telegram_test', ${channel})`);
    await x(sql`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, allowlist_status, login_id)
      values (${chat}, ${account}, ${owner}, '9201', 'private', 'allowed', ${owner})`);

    // Healed: replied, never marked (processed_at empty, and set).
    await message('replied', 'inbound');
    await message('replied-out', 'outbound', { replyTo: row.replied });
    await message('replied-stamped', 'inbound', { processedAt: OLD });
    await message('replied-stamped-out', 'outbound', { replyTo: row['replied-stamped'] });
    // Not healed: no reply; already processed; an inbound answer is no reply.
    await message('pending', 'inbound');
    await message('done', 'inbound', { processed: true });
    await message('done-out', 'outbound', { replyTo: row.done });
    await message('inbound-answered', 'inbound');
    await message('inbound-answer', 'inbound', { replyTo: row['inbound-answered'] });
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('flips the replied rows only, as the raw text does', async () => {
    const before = await state();
    // The reference, rolled back: the rows it would heal.
    const sqlClient = (m.systemDb as unknown as { $client: import('postgres').Sql }).$client;
    const reference: string[] = [];
    await sqlClient
      .begin(async (tx) => {
        for (const r of (await tx.unsafe(REFERENCE)) as unknown as { id: string }[]) {
          reference.push(r.id);
        }
        throw new Error('rollback');
      })
      .catch((err: unknown) => {
        if (String(err).includes('rollback')) return;
        throw err;
      });
    expect(await state()).toEqual(before);

    const { healRepliedTelegramMessages } = await import('./runtime');
    const healed = await healRepliedTelegramMessages();
    const want = [row.replied, row['replied-stamped']].sort();
    expect(reference.sort()).toEqual(want);
    expect(healed).toBe(2);

    const after = new Map((await state()).map((r) => [r.id, r]));
    expect(after.get(row.replied!)?.processed).toBe(true);
    expect(after.get(row.replied!)?.processed_at).not.toBeNull();
    expect(after.get(row['replied-stamped']!)).toMatchObject({ processed: true });
    expect(new Date(after.get(row['replied-stamped']!)!.processed_at!).toISOString()).toBe(OLD);
    // Every other row as it was.
    for (const r of before) {
      if (want.includes(r.id)) continue;
      expect(after.get(r.id)).toEqual(r);
    }
  });
});
