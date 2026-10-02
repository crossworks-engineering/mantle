import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `brain_identity`: this brain's own stable id (migration 0226). One row.
 *
 * A phone or a desktop may hold logins on several brains at once, with one OS
 * push token for all of them. Every push payload and every whoami answer
 * names this id, so the app can tell which brain a push came from and switch
 * to the right session (docs/mobile-companion-backend.md, "Push routing on a
 * device with several logins").
 *
 * Random, so it says nothing about the brain: not its address, not its
 * owner, not a secret. Written once by the migration and never changed by
 * the code: it survives restarts, upgrades and a restore of this brain's own
 * backup. A database cloned from another brain's dump carries that brain's
 * id; give the clone its own with
 * `update brain_identity set brain_id = gen_random_uuid()` before any phone
 * signs in to it (then restart the server and the push worker).
 */
export const brainIdentity = pgTable(
  'brain_identity',
  {
    /** Singleton guard: the primary key, and it can only be true. */
    singleton: boolean('singleton').primaryKey().default(true),
    brainId: uuid('brain_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('brain_identity_singleton_ck', sql`${t.singleton}`)],
);

export type BrainIdentity = typeof brainIdentity.$inferSelect;
