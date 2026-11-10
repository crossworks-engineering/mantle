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
import type { BoxStatus } from '@mantle/client-types';

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

/** A model id as the fleet sends and keeps one (phase 3 facts, phase 4
 *  agentModel): its length is held by the pattern too. */
export const CONTROL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** A slug as a shipped agent, a worker, a group or a pool has one. */
export const CONTROL_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A display name (a pool entry's name and vendor, a group's name). */
export const CONTROL_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/()+&'-]{0,119}$/u;
/** A provider id, as a pool entry's route names one. */
export const CONTROL_PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The most changes one request queues. */
export const CONTROL_MAX_WRITE_CHANGES = 20;

/** The most changes that wait for one box, and the most results it keeps. */
export const CONTROL_MAX_WAITING_WRITES = 40;

/** One fleet write (phase 4), each a fixed case on the signed route, the
 *  case's name its kind. No secret in any of them. */
export type ControlWriteChange =
  | { kind: 'agentModel'; slug: string; model: string }
  | {
      kind: 'poolEntry';
      pool: string;
      name: string;
      vendor?: string;
      routes: { provider: string; model: string }[];
    }
  | { kind: 'updateNotice'; on: boolean }
  | { kind: 'workerGroup'; slug: string; name?: string; members: string[]; enabled?: boolean };

/** Who asked a change, and when (its hour runs from here). */
export type ControlWriteStamp = { by: string; at: string };

/** The changes waiting for the control service (0367, 0368), in the order
 *  asked. The service sends each once and takes the sent ones off the
 *  front; one older than an hour is dropped unsent. */
export type ControlWriteJob = { changes: (ControlWriteChange & ControlWriteStamp)[] };

/** A box's answer to one change: ok and what it had (`was`), or a reason
 *  (the box's, or a call's code, or expired). `done` is when. */
export type ControlWriteAnswer = ControlWriteChange &
  ControlWriteStamp & { ok: boolean; was: string | null; reason: string | null; done: string };

/** The box's answers (0368): the last CONTROL_MAX_WAITING_WRITES, newest last. */
export type ControlWriteResult = { results: ControlWriteAnswer[] };

/** The most agent rows, and worker rows, one facts answer carries (the box
 *  sends at most this many; the CC keeps at most this many). */
export const CONTROL_FACTS_MAX_ROWS = 500;

/**
 * What a box answers to `facts` (0366, phase 3, the fleet matrix): numbers,
 * settings, short ids and model ids only. Never a display name, a prompt, a
 * key or any user data. `status` is box_status's schema 1 (null when the
 * box could not collect it). The CC holds every string to a pattern; a
 * value that does not fit is kept as ''.
 */
export type ControlFacts = {
  schema: 1;
  /** The box's own time of the answer. */
  at: string;
  status: BoxStatus | null;
  /** The company sign-in mode as the box runs it. */
  signIn: 'off' | 'optional' | 'required';
  agents: {
    /** A slug the system ships (the manifest's), else null: any other slug
     *  is made from a name someone gave the agent. */
    slug: string | null;
    role: string;
    provider: string;
    model: string;
    enabled: boolean;
    /** A person's own assistant. */
    assigned: boolean;
  }[];
  /** By kind alone: a worker's slug may be made from a name. */
  workers: { kind: string; provider: string; model: string; enabled: boolean }[];
  counts: { workspaces: number; apps: number };
  backup: { lastRunAt: string; ok: boolean; lastSuccessAt: string | null } | null;
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
  /** The box's last good `facts` answer (0366, the fleet matrix). */
  facts: jsonb('facts').$type<ControlFacts>(),
  /** Null after a good facts read; else its reason code. The last good
   *  facts stay, with their own time. */
  factsReason: text('facts_reason'),
  /** Fleet writes waiting for the box's next run (0367, 0368): taken off
   *  when sent, or unsent after an hour. */
  writeJob: jsonb('write_job').$type<ControlWriteJob>(),
  /** The box's last answers to fleet writes (0368). */
  writeResult: jsonb('write_result').$type<ControlWriteResult>(),
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
