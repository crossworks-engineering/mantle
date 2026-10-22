/**
 * The chat's assistant in one place: the override answers before the bot's
 * assistant, and the bot's assistant is one subquery for an id or a column.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('@mantle/db', async () => {
  const schema = await import('@mantle/db/schema');
  return { ...schema, db: {} };
});

const { botAgentIdSql, chatAnsweringAgentId } = await import('./chat-assistant');
const { telegramMessages } = await import('@mantle/db/schema');

describe('which assistant a Telegram chat runs as', () => {
  it('the override answers, else the bot assistant, else none', () => {
    expect(chatAnsweringAgentId('o', 'b')).toBe('o');
    expect(chatAnsweringAgentId(null, 'b')).toBe('b');
    expect(chatAnsweringAgentId(undefined, null)).toBeNull();
  });
  it("the bot's assistant: one subquery for an id or a column", () => {
    const d = new PgDialect();
    const byId = d.sqlToQuery(botAgentIdSql('00000000-0000-0000-0000-000000000001'));
    expect(byId.sql.replace(/\s+/g, ' ')).toBe(
      'select ch.agent_id from channels ch join telegram_accounts t on t.channel_id = ch.id where t.id = $1::uuid',
    );
    expect(byId.params).toEqual(['00000000-0000-0000-0000-000000000001']);
    const byColumn = d.sqlToQuery(botAgentIdSql(telegramMessages.accountId));
    expect(byColumn.sql.replace(/\s+/g, ' ')).toBe(
      'select ch.agent_id from channels ch join telegram_accounts t on t.channel_id = ch.id where t.id = "telegram_messages"."account_id"',
    );
    expect(byColumn.params).toEqual([]);
  });
});
