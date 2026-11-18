import { sql } from 'drizzle-orm';
import { customType, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * The state of an optional service (migration 0380; Sync service plan M2).
 * One row per (service, key): the Sync sidecar's linked accounts, feeds and
 * sync cursors. `valueEnc` is sealed with the master key by the brain (AAD
 * `service:key`); the sidecar itself keeps no disk. Read and written only by
 * the sidecar routes, on the system pool (service-state.ts).
 */
export const serviceState = pgTable(
  'service_state',
  {
    service: text('service').notNull(),
    key: text('key').notNull(),
    valueEnc: bytea('value_enc').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.service, t.key] })],
);

export type ServiceStateRow = typeof serviceState.$inferSelect;
