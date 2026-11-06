import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';

/**
 * The agent UI channel's calls (migration 0363, docs/agent-ui.md): one row
 * per ui_* tool call an in-app agent makes on the window its turn named. The
 * tool inserts the row and waits; the window answers it once
 * (POST /api/assistant/turn/:turnId/ui/:callId, ui-calls.ts answerUiCall).
 *
 * `turn_id` is the turn's stream id (the client-minted idempotency key), so
 * `text`. `step_key` is the turn id and the tool call's own id: a DBOS re-run
 * of the same step finds its row again instead of asking the window twice.
 * `status`: 'pending' until answered ('done', `result` set) or given up
 * ('expired': the turn was stopped). A pending row past `expires_at` is
 * never answered (the answer's UPDATE asks `expires_at > now()`).
 *
 * Read: a login its own rows only (the row rule of 0363). Written through
 * systemDb only. Rows are tiny; the maintenance sweep is not needed.
 */
export const uiCalls = pgTable(
  'ui_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    turnId: text('turn_id').notNull(),
    loginId: uuid('login_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    windowId: text('window_id').notNull(),
    stepKey: text('step_key').notNull(),
    action: text('action').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<'pending' | 'done' | 'expired'>().notNull().default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('ui_calls_step_key_idx').on(t.stepKey),
    index('ui_calls_turn_idx').on(t.turnId),
    index('ui_calls_created_idx').on(t.createdAt),
  ],
);

export type UiCallRow = typeof uiCalls.$inferSelect;
