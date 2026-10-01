/**
 * A contact's sharing code (contact shares, migration 0214; docs/sharing.md,
 * "Contact shares"). An admin switches on "Enable sharing" on a contact; the
 * contact gets an 8-character code, shown once. A contact share's link plus
 * this code opens the item.
 *
 * Properties the gate and the code prompt rely on:
 *  - the code is 8 characters from the look-alike-free 54-character alphabet
 *    (about 46 bits), rejection sampled, so every character is equally
 *    likely;
 *  - only an HMAC-SHA256 of (contact id, code) is stored, keyed from
 *    MANTLE_MASTER_KEY (HKDF, fixed label): a copy of the database alone
 *    recovers no code. A master key change kills every code (regenerate);
 *  - `code_epoch` only goes up: regenerate and switch off both move it, so
 *    every visitor cookie of the contact dies on its next request, and the
 *    row is never deleted while the contact exists, so an old cookie can
 *    never match again after Enable;
 *  - switch off revokes every live share of the contact in the same
 *    transaction (decision 3); Enable again starts with a new code and no
 *    shares;
 *  - the failure counters live in the row (a restart or a second web
 *    process does not reset them): 30 failures in a day lock the contact for
 *    24 hours; a share takes 10 failures an hour (counted from
 *    share_access_log);
 *  - every failure to check a code is the same `null`, after the same work
 *    ({@link codeCheckSteps}).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { contactShareCodes, db, nodes, shareAccessLog, shares } from '@mantle/db';
import { env } from '@mantle/config';

export const CONTACT_CODE_LENGTH = 8;
/** Failures a contact takes in its day window before it is locked. */
export const CONTACT_CODE_DAILY_FAILURES = 30;
/** How long a lock lasts. */
export const CONTACT_CODE_LOCK_MS = 24 * 60 * 60 * 1000;
/** Failures one share takes in an hour, then it refuses every code. */
export const CONTACT_CODE_SHARE_HOURLY_FAILURES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Mixed-case alphanumerics minus the look-alikes (0/O/o, 1/l/I/i), so a
 *  code read over the phone or retyped from paper survives the trip: the
 *  alphabet of the retired team codes (migration 0112). It is 54 characters,
 *  not the 56 that code's comment said, so the rejection bound is computed
 *  from the real length (a fixed 224 would favour the first characters). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
/** The largest multiple of the alphabet length below 256: bytes at or
 *  above it are thrown away, so every character is equally likely. */
const REJECT_AT = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;

/** An id no row has: the no-match branches run the same statements on it. */
const NO_ID = '00000000-0000-0000-0000-000000000000';
/** Compared against when no code is stored: the length of a real hash. */
const NO_HASH = '0'.repeat(64);
/** HKDF label of the code key: fixed, so every process derives one key. */
const CODE_KEY_INFO = 'mantle contact share code v1';

let codeKeyCache: { master: string; key: Buffer } | undefined;

/** The HMAC key for contact codes, derived from MANTLE_MASTER_KEY. Throws
 *  when the master key is not set: no code is made or checked without it. */
function codeKey(): Buffer {
  const master = env('MANTLE_MASTER_KEY');
  if (!master) throw new Error('MANTLE_MASTER_KEY must be set to make or check a contact code');
  if (codeKeyCache?.master !== master) {
    codeKeyCache = {
      master,
      key: Buffer.from(
        hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), CODE_KEY_INFO, 32),
      ),
    };
  }
  return codeKeyCache.key;
}

/** A fresh code: 8 characters, every character equally likely. */
export function generateContactCode(): string {
  const out: string[] = [];
  while (out.length < CONTACT_CODE_LENGTH) {
    // Rejection sampling: only bytes below REJECT_AT are used.
    for (const b of randomBytes(CONTACT_CODE_LENGTH * 2)) {
      if (b >= REJECT_AT) continue;
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
      if (out.length === CONTACT_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

/** What a typed code is compared as: trimmed, spaces dropped. Case stays. */
export function normalizeContactCode(input: string): string {
  return input.replace(/\s+/g, '');
}

/** HMAC-SHA256 hex of a code bound to its contact: what `code_hash` holds. */
export function hashContactCode(contactId: string, code: string): string {
  return createHmac('sha256', codeKey())
    .update(`${contactId.toLowerCase()}:${code}`, 'utf8')
    .digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Owner-scoped guard: the id is one of this owner's contact nodes. */
async function isOwnContact(q: Tx | typeof db, ownerId: string, contactId: string) {
  const [row] = await q
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, contactId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  return !!row;
}

/** A contact's sharing, as the contact DTO shows it (null: sharing off). */
export type ContactSharingStatus = {
  /** When the current code was made (Enable or Regenerate). */
  enabledAt: string;
  lastUsedAt: string | null;
  /** 30 failed codes in a day: the code opens nothing until it lapses or an
   *  admin regenerates. */
  locked: boolean;
  /** Live contact shares of the contact. */
  shareCount: number;
};

/** Sharing status of each of `contactIds` (only those with sharing on). */
export async function contactSharingByContact(
  ownerId: string,
  contactIds: readonly string[],
  now = new Date(),
): Promise<Map<string, ContactSharingStatus>> {
  const out = new Map<string, ContactSharingStatus>();
  if (contactIds.length === 0) return out;
  const rows = await db
    .select({
      contactId: contactShareCodes.contactId,
      createdAt: contactShareCodes.createdAt,
      rotatedAt: contactShareCodes.rotatedAt,
      lastUsedAt: contactShareCodes.lastUsedAt,
      lockedUntil: contactShareCodes.lockedUntil,
    })
    .from(contactShareCodes)
    .where(
      and(
        eq(contactShareCodes.ownerId, ownerId),
        inArray(contactShareCodes.contactId, [...contactIds]),
        isNotNull(contactShareCodes.codeHash),
      ),
    );
  if (rows.length === 0) return out;
  const counts = await db
    .select({ contactId: shares.contactId, n: count() })
    .from(shares)
    .where(
      and(
        eq(shares.ownerId, ownerId),
        inArray(
          shares.contactId,
          rows.map((r) => r.contactId),
        ),
        isNull(shares.revokedAt),
        sql`(${shares.expiresAt} is null or ${shares.expiresAt} > now())`,
      ),
    )
    .groupBy(shares.contactId);
  const byContact = new Map(counts.map((c) => [c.contactId, c.n]));
  for (const r of rows) {
    out.set(r.contactId, {
      enabledAt: (r.rotatedAt ?? r.createdAt).toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      locked: !!r.lockedUntil && r.lockedUntil > now,
      shareCount: byContact.get(r.contactId) ?? 0,
    });
  }
  return out;
}

/** One contact's sharing status (null: off, or not this owner's contact). */
export async function contactSharingFor(
  ownerId: string,
  contactId: string,
): Promise<ContactSharingStatus | null> {
  return (await contactSharingByContact(ownerId, [contactId])).get(contactId) ?? null;
}

/**
 *   { code }       a new code, shown once;
 *   { alreadyOn }  sharing was on: nothing changed (use regenerate);
 *   null           not a contact of this owner.
 */
export type EnableContactSharingResult = { code: string } | { alreadyOn: true } | null;

/**
 * Switch sharing on. A contact that had sharing before (and was switched
 * off) gets a new code and a higher epoch, and starts with no shares (switch
 * off revoked them).
 */
export async function enableContactSharing(
  ownerId: string,
  contactId: string,
  now = new Date(),
): Promise<EnableContactSharingResult> {
  return db.transaction(async (tx) => {
    if (!(await isOwnContact(tx, ownerId, contactId))) return null;
    const code = generateContactCode();
    const codeHash = hashContactCode(contactId, code);
    const [existing] = await tx
      .select({ codeHash: contactShareCodes.codeHash })
      .from(contactShareCodes)
      .where(eq(contactShareCodes.contactId, contactId))
      .for('update')
      .limit(1);
    if (existing?.codeHash) return { alreadyOn: true };
    if (!existing) {
      await tx.insert(contactShareCodes).values({ contactId, ownerId, codeHash, createdAt: now });
    } else {
      await tx
        .update(contactShareCodes)
        .set({
          codeHash,
          codeEpoch: sql`${contactShareCodes.codeEpoch} + 1`,
          disabledAt: null,
          failedAttempts: 0,
          failedSince: null,
          lockedUntil: null,
          rotatedAt: now,
        })
        .where(eq(contactShareCodes.contactId, contactId));
    }
    return { code };
  });
}

/** A new code for a contact with sharing on (the old one stops at once,
 *  and every visitor cookie with it). Clears a lock. Null when sharing is
 *  off or the contact is not this owner's. */
export async function regenerateContactCode(
  ownerId: string,
  contactId: string,
  now = new Date(),
): Promise<{ code: string } | null> {
  const code = generateContactCode();
  const rows = await db
    .update(contactShareCodes)
    .set({
      codeHash: hashContactCode(contactId, code),
      codeEpoch: sql`${contactShareCodes.codeEpoch} + 1`,
      failedAttempts: 0,
      failedSince: null,
      lockedUntil: null,
      rotatedAt: now,
    })
    .where(
      and(
        eq(contactShareCodes.contactId, contactId),
        eq(contactShareCodes.ownerId, ownerId),
        isNotNull(contactShareCodes.codeHash),
      ),
    )
    .returning({ id: contactShareCodes.contactId });
  return rows.length ? { code } : null;
}

/**
 * Switch sharing off: the code goes, the epoch moves (every cookie dies),
 * and every live share of the contact is revoked, all in one transaction
 * (decision 3). No level changes: a contact share never set one. Null when
 * sharing was already off or the contact is not this owner's.
 */
export async function disableContactSharing(
  ownerId: string,
  contactId: string,
  now = new Date(),
): Promise<{ revoked: number } | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(contactShareCodes)
      .set({
        codeHash: null,
        disabledAt: now,
        codeEpoch: sql`${contactShareCodes.codeEpoch} + 1`,
        failedAttempts: 0,
        failedSince: null,
        lockedUntil: null,
      })
      .where(
        and(
          eq(contactShareCodes.contactId, contactId),
          eq(contactShareCodes.ownerId, ownerId),
          isNotNull(contactShareCodes.codeHash),
        ),
      )
      .returning({ id: contactShareCodes.contactId });
    if (!rows.length) return null;
    const revoked = await tx
      .update(shares)
      .set({ revokedAt: now })
      .where(
        and(eq(shares.ownerId, ownerId), eq(shares.contactId, contactId), isNull(shares.revokedAt)),
      )
      .returning({ id: shares.id });
    return { revoked: revoked.length };
  });
}

/** What the gate needs of a contact on every request. */
export type ContactShareGateRow = {
  ownerId: string;
  codeEpoch: number;
  /** Sharing on (a code is set) and not locked. */
  open: boolean;
};

/** The gate's liveness read: one row by primary key. */
export async function contactShareGateRow(
  contactId: string,
  now = new Date(),
): Promise<ContactShareGateRow | null> {
  const [row] = await db
    .select({
      ownerId: contactShareCodes.ownerId,
      codeEpoch: contactShareCodes.codeEpoch,
      codeHash: contactShareCodes.codeHash,
      lockedUntil: contactShareCodes.lockedUntil,
    })
    .from(contactShareCodes)
    .where(eq(contactShareCodes.contactId, contactId))
    .limit(1);
  if (!row) return null;
  return {
    ownerId: row.ownerId,
    codeEpoch: row.codeEpoch,
    open: row.codeHash !== null && !(row.lockedUntil && row.lockedUntil > now),
  };
}

/** The share a code is presented to (the code prompt resolves it first);
 *  null when the token named no active share. */
export type CodeCheckShare = { id: string; ownerId: string; contactId: string | null };

export type ContactCodeAccepted = {
  contactId: string;
  ownerId: string;
  codeEpoch: number;
};

export type ContactCodeRejected = {
  /** This failure locked the contact (30 in a day): audit and notice. */
  lockedNow: boolean;
  /** The contact the share names, when it names one (for the audit). */
  contactId: string | null;
};

type CodeRow = {
  contactId: string;
  ownerId: string;
  codeHash: string | null;
  codeEpoch: number;
  failedAttempts: number;
  failedSince: Date | null;
  lockedUntil: Date | null;
};

/**
 * The steps of a code check, which every branch runs in the same order: a
 * wrong code, sharing off, a locked contact, a revoked share and an open
 * link do the same work, so the timing does not tell them apart. Exported
 * for the test that pins the one path; not for other callers.
 */
export const codeCheckSteps = {
  /** The contact's code row, locked (the counters rest on the lock). Runs
   *  against an id no row has when the share names no contact. */
  async findRow(tx: Tx, contactId: string | null): Promise<CodeRow | null> {
    const [row] = await tx
      .select({
        contactId: contactShareCodes.contactId,
        ownerId: contactShareCodes.ownerId,
        codeHash: contactShareCodes.codeHash,
        codeEpoch: contactShareCodes.codeEpoch,
        failedAttempts: contactShareCodes.failedAttempts,
        failedSince: contactShareCodes.failedSince,
        lockedUntil: contactShareCodes.lockedUntil,
      })
      .from(contactShareCodes)
      .where(eq(contactShareCodes.contactId, contactId ?? NO_ID))
      .limit(1)
      .for('update');
    return row ?? null;
  },
  /** Failed codes on this share in the last hour. */
  async shareFailures(tx: Tx, shareId: string | null, now: Date): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(shareAccessLog)
      .where(
        and(
          eq(shareAccessLog.shareId, shareId ?? NO_ID),
          eq(shareAccessLog.kind, 'code_failed'),
          gt(shareAccessLog.createdAt, new Date(now.getTime() - HOUR_MS)),
        ),
      );
    return row?.n ?? 0;
  },
  /** Hash and compare; against a dummy when no code is stored. */
  checkCode(contactId: string | null, code: string, storedHash: string | null): boolean {
    const same = sameHash(hashContactCode(contactId ?? NO_ID, code), storedHash ?? NO_HASH);
    return same && storedHash !== null;
  },
  /** A failure: counted on the contact's row (the same statement touches
   *  nothing with no row) and logged on the share (a statement that writes
   *  nothing with no share). Returns whether this failure locked it. */
  async countFailure(
    tx: Tx,
    share: CodeCheckShare | null,
    row: CodeRow | null,
    now: Date,
  ): Promise<boolean> {
    const windowOpen = !!row?.failedSince && now.getTime() - row.failedSince.getTime() < DAY_MS;
    const failures = (windowOpen ? (row?.failedAttempts ?? 0) : 0) + 1;
    const alreadyLocked = !!row?.lockedUntil && row.lockedUntil > now;
    const lockNow = !!row && !alreadyLocked && failures >= CONTACT_CODE_DAILY_FAILURES;
    await tx
      .update(contactShareCodes)
      .set({
        failedAttempts: lockNow ? 0 : failures,
        failedSince: lockNow ? null : windowOpen ? row!.failedSince : now,
        ...(lockNow ? { lockedUntil: new Date(now.getTime() + CONTACT_CODE_LOCK_MS) } : {}),
      })
      .where(eq(contactShareCodes.contactId, row?.contactId ?? NO_ID));
    await tx.execute(sql`
      insert into share_access_log (owner_id, share_id, contact_id, kind, detail, created_at)
      select s.owner_id, s.id, s.contact_id, 'code_failed', ${JSON.stringify(lockNow ? { locked: true } : {})}::jsonb, ${now.toISOString()}::timestamptz
        from shares s where s.id = ${share?.id ?? NO_ID}`);
    return lockNow;
  },
  async accept(tx: Tx, row: CodeRow, now: Date): Promise<void> {
    await tx
      .update(contactShareCodes)
      .set({ failedAttempts: 0, failedSince: null, lastUsedAt: now })
      .where(eq(contactShareCodes.contactId, row.contactId));
  },
};

/**
 * Check a code typed at a contact share's prompt, in ONE transaction. It
 * opens only when the share names a contact of its own brain, that contact
 * has sharing on and is not locked, the share has not taken 10 failures in
 * the last hour, and the code matches. Every other case is the same
 * `{ ok: false }` after the same steps ({@link codeCheckSteps}).
 */
export async function checkContactShareCode(
  share: CodeCheckShare | null,
  rawCode: string,
  now = new Date(),
): Promise<({ ok: true } & ContactCodeAccepted) | ({ ok: false } & ContactCodeRejected)> {
  const code = normalizeContactCode(rawCode).slice(0, 64);
  const steps = codeCheckSteps;
  const contactId = share?.contactId ?? null;
  return db.transaction(async (tx) => {
    const row = await steps.findRow(tx, contactId);
    const failures = await steps.shareFailures(tx, share?.id ?? null, now);
    const match = steps.checkCode(contactId, code, row?.codeHash ?? null);
    const usable =
      !!share &&
      !!row &&
      row.ownerId === share.ownerId &&
      row.codeHash !== null &&
      !(row.lockedUntil && row.lockedUntil > now) &&
      failures < CONTACT_CODE_SHARE_HOURLY_FAILURES &&
      code.length === CONTACT_CODE_LENGTH;
    if (!usable || !match || !row) {
      const lockedNow = await steps.countFailure(tx, share, row, now);
      return { ok: false, lockedNow, contactId };
    }
    await steps.accept(tx, row, now);
    return { ok: true, contactId: row.contactId, ownerId: row.ownerId, codeEpoch: row.codeEpoch };
  });
}

/** Contacts locked now, for "Needs you": a count query (never a capped
 *  list) and the newest lock. */
export async function lockedContactSharing(
  ownerId: string,
  now = new Date(),
): Promise<{ count: number; newest: { id: string; title: string; at: string } | null }> {
  const lockedNow = and(
    eq(contactShareCodes.ownerId, ownerId),
    isNotNull(contactShareCodes.codeHash),
    gt(contactShareCodes.lockedUntil, now),
  );
  const [[counted], [first]] = await Promise.all([
    db.select({ n: count() }).from(contactShareCodes).where(lockedNow),
    db
      .select({
        id: contactShareCodes.contactId,
        title: nodes.title,
        lockedUntil: contactShareCodes.lockedUntil,
      })
      .from(contactShareCodes)
      .innerJoin(nodes, eq(nodes.id, contactShareCodes.contactId))
      .where(lockedNow)
      .orderBy(sql`${contactShareCodes.lockedUntil} desc`)
      .limit(1),
  ]);
  return {
    count: counted?.n ?? 0,
    newest: first
      ? {
          id: first.id,
          title: first.title,
          at: new Date(first.lockedUntil!.getTime() - CONTACT_CODE_LOCK_MS).toISOString(),
        }
      : null,
  };
}
