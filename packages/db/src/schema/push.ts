import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Push-notification state (Mantle Push, M2). See
 * ../../../../mantle-companion/docs/push-notifications.md §8.
 *
 * `push_instance` — THIS install's identity with the relay. Single row. The
 * instance token is the long-lived secret that authenticates Mantle → Mantle
 * Push; it is stored **encrypted at rest** (@mantle/crypto sealed → base64), so
 * a DB leak doesn't hand over the relay credential. `relay_instance_id` is the
 * opaque id the relay returns from POST /instances (goes in enrollment tickets).
 */
export const pushInstance = pgTable(
  'push_instance',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** base64( @mantle/crypto seal(instanceToken) ). */
    instanceTokenEnc: text('instance_token_enc').notNull(),
    /** The relay's opaque id for this install (from POST /instances). */
    relayInstanceId: text('relay_instance_id').notNull(),
    relayUrl: text('relay_url').notNull().default('https://push.crossworks.network'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
    /** Singleton guard — exactly one row (unique index below). */
    singleton: boolean('singleton').notNull().default(true),
  },
  (t) => [uniqueIndex('push_instance_singleton_uq').on(t.singleton)],
);

export type PushInstance = typeof pushInstance.$inferSelect;
export type NewPushInstance = typeof pushInstance.$inferInsert;

/**
 * `push_subscriptions` — one row per enrolled device. `routing_token` is the
 * opaque handle the relay minted at /enroll (Mantle → relay /notify targets it);
 * `public_key` is the device's X25519 public key that each payload is sealed to
 * (libsodium crypto_box_seal). No private keys, no message bodies — those live
 * only on the device.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** The relay's deviceId (from /enroll), kept for reference/unpair. */
    relayDeviceId: text('relay_device_id'),
    routingToken: text('routing_token').notNull(),
    /** Device X25519 public key, base64. */
    publicKey: text('public_key').notNull(),
    platform: text('platform').notNull(), // 'ios' | 'android'
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastPushAt: timestamp('last_push_at', { withTimezone: true }),
  },
  (t) => [index('push_subscriptions_owner_idx').on(t.ownerId)],
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

/**
 * `push_prefs` — single-row notification preferences (push-notifications.md §10).
 * Per-trigger toggles, enforced Mantle-side by the send-worker before it calls
 * the relay. Quiet hours were removed (docs/reminder-delivery-routing.md §C) —
 * OS-level Do Not Disturb covers night-time muting for a mobile app, so the
 * `quiet_*` + `timezone` columns are gone.
 */
export const pushPrefs = pgTable(
  'push_prefs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Push outbound assistant turns (the assistant reaching out). */
    assistantMessages: boolean('assistant_messages').notNull().default(true),
    /** Push when a tool call needs approval. */
    approvals: boolean('approvals').notNull().default(true),
    singleton: boolean('singleton').notNull().default(true),
  },
  (t) => [uniqueIndex('push_prefs_singleton_uq').on(t.singleton)],
);

export type PushPrefsRow = typeof pushPrefs.$inferSelect;
