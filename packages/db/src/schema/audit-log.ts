import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Human action trail. One row per auth event, user-management action, and — via
 * the `getOwnerOr401` choke point — every mutating API call, attributed to the
 * ACTOR (the logged-in login, not the anchor the data is keyed to).
 *
 * `actor_email` is denormalized so the trail survives user deletion; the FK to
 * auth.users(id) is declared in SQL only (ON DELETE SET NULL), like every other
 * cross-schema FK.
 *
 * Actions: 'auth.login' | 'auth.login_failed' | 'auth.logout' |
 * 'auth.password_change' | 'user.create' | 'user.update' | 'user.delete' |
 * 'user.password_reset' | 'api.write'.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`).notNull(),
    actorId: uuid('actor_id'),
    actorEmail: text('actor_email').notNull(),
    action: text('action').notNull(),
    method: text('method'),
    path: text('path'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt.desc()),
    index('audit_log_actor_idx').on(t.actorId),
    index('audit_log_action_idx').on(t.action),
    index('audit_log_actor_email_idx').on(t.actorEmail),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
