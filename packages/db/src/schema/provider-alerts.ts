import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Provider alerts (migration 0230): the open embedding or extraction outage of
 * a brain, one row per subject, in words an admin can act on. Written on the
 * admin pool by the embedder and the extract queue
 * (packages/db/src/provider-alerts.ts); read by admin routes only. The
 * `reason` is fixed text chosen by error code, never provider text.
 */
export const providerAlerts = pgTable(
  'provider_alerts',
  {
    ownerId: uuid('owner_id').notNull(),
    /** 'embedding' | 'extraction'. */
    subject: text('subject').notNull(),
    /** ProviderErrorCode from @mantle/embeddings provider-error.ts. */
    code: text('code').notNull(),
    permanent: boolean('permanent').notNull(),
    reason: text('reason').notNull(),
    provider: text('provider'),
    model: text('model'),
    failingSince: timestamp('failing_since', { withTimezone: true }).defaultNow().notNull(),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }).defaultNow().notNull(),
    errorCount: integer('error_count').notNull().default(1),
    /** Shown to admins: permanent at once, transient after 10 min. */
    visible: boolean('visible').notNull().default(false),
    /** The extract queue stopped taking jobs for it. */
    paused: boolean('paused').notNull().default(false),
    nextProbeAt: timestamp('next_probe_at', { withTimezone: true }),
    probeAttempts: integer('probe_attempts').notNull().default(0),
    lastProbeAt: timestamp('last_probe_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.subject] })],
);

export type ProviderAlertRow = typeof providerAlerts.$inferSelect;
