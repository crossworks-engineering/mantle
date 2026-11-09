import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Control Center phase 1, the fleet user ban (migration 0364,
 * docs/control-center.md).
 *
 * `control_disables` is on every box: the logins the Control Center (CC)
 * disabled, with the disabled_at it set. The CC enables a login again only
 * while that is still the login's disabled_at.
 *
 * The other four are on the CC only: the linked boxes, the bans, per ban
 * and box what the last run matched, and the control service's row (its
 * public key; the private key never reaches the database).
 *
 * `login_id` FKs into auth.users in the SQL migration (Drizzle only manages
 * public.*; see schema/auth-users.ts).
 */
export const controlDisables = pgTable('control_disables', {
  loginId: uuid('login_id').primaryKey(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** A provider key waiting for the control service (0365): the value is
 *  sealed with the master key, AAD controlKeyAad(box id). */
export type ControlKeyJob = { service: string; sealed: string; by: string; at: string };

/** What a box answered to the last key call (0365). Never a value. */
export type ControlKeyResult = {
  service: string;
  ok: boolean;
  reason: string | null;
  by: string;
  at: string;
};

/** One login of a box, as the box's `logins` answer gives it. */
export type ControlLogin = {
  id: string;
  email: string;
  owner: boolean;
  disabled: boolean;
  archived: boolean;
  /** Disabled by the CC, and still with the disabled_at it set. */
  marked: boolean;
  links: { issuer: string; oid: string }[];
};

export const controlBoxes = pgTable('control_boxes', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** The box's origin, typed by a CC Admin: https, no path. */
  url: text('url').notNull().unique(),
  label: text('label'),
  addedBy: text('added_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** Set by the brain to ask the control service for a run now. */
  runRequestedAt: timestamp('run_requested_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  /** Null after a good run; else a short reason code (off, time, sig,
   *  unreachable, http-NNN, bad-reply). */
  lastReason: text('last_reason'),
  lastResult: jsonb('last_result').$type<Record<string, unknown>>(),
  /** The box's last login list (for the fleet preview of a new ban). */
  logins: jsonb('logins').$type<ControlLogin[]>(),
  /** A provider key waiting for the box's next run (0365), sealed; cleared
   *  when it is sent, or unsent after an hour (expireControlKeyJobs). */
  keyJob: jsonb('key_job').$type<ControlKeyJob>(),
  /** The box's answer to the last key call (0365). */
  keyResult: jsonb('key_result').$type<ControlKeyResult>(),
});

export const controlBans = pgTable('control_bans', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  kind: text('kind').$type<'disable' | 'archive'>().notNull().default('disable'),
  /** Lowercase. */
  emails: text('emails')
    .array()
    .notNull()
    .default(sql`'{}'`),
  issuer: text('issuer'),
  oid: text('oid'),
  reason: text('reason'),
  madeBy: text('made_by'),
  madeAt: timestamp('made_at', { withTimezone: true }).defaultNow().notNull(),
  liftedBy: text('lifted_by'),
  liftedAt: timestamp('lifted_at', { withTimezone: true }),
});

export const controlResults = pgTable(
  'control_results',
  {
    banId: uuid('ban_id').notNull(),
    boxId: uuid('box_id').notNull(),
    /** Logins on the box the ban matches. */
    matched: integer('matched').notNull().default(0),
    /** The box owner, when it matched: it is never disabled. */
    ownerIds: uuid('owner_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.banId, t.boxId] })],
);

export const controlService = pgTable('control_service', {
  id: boolean('id').primaryKey().default(true),
  /** `ed25519:` + base64 of the 32 raw bytes: the line a subject box sets
   *  as MANTLE_CONTROL_CENTER_KEY. */
  publicKey: text('public_key').notNull(),
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
