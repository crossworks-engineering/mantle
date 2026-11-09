/**
 * The Control Center's own rows (migration 0364, docs/control-center.md):
 * the linked boxes, the bans, per ban and box what the last run matched,
 * and the control service's row. The one module both the Fleet routes and
 * tools (server/web, packages/tools) and the control service
 * (server/web/workers/control.ts) use.
 *
 * The match (plan section 3.4) runs here, at the CC, never on a box: a
 * login matches a ban when its email, lowercased, is one of the ban's, or
 * when one of its company sign-in links has the ban's issuer and object id.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from './gateway/handles';
import {
  controlBans,
  controlBoxes,
  controlResults,
  controlService,
  type ControlLogin,
} from './schema/control';

export type ControlBan = typeof controlBans.$inferSelect;
export type ControlBox = typeof controlBoxes.$inferSelect;
export type BanKeys = Pick<ControlBan, 'emails' | 'issuer' | 'oid'>;

/** How often the control service runs every box (plan section 3.1). */
export const CONTROL_RUN_EVERY_MS = 5 * 60_000;
/** The most emails one ban names. */
export const CONTROL_MAX_BAN_EMAILS = 50;

// --- input -------------------------------------------------------------------

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A box URL as a CC Admin types it: https, a host, no path, query or
 *  credentials. The origin is what is stored and signed. */
export function checkBoxUrl(input: string): Checked<string> {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: 'Give the box URL, for example https://box.example.com.' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'The box URL must start with https://.' };
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { ok: false, error: 'Give the box origin only: https and the host, no path.' };
  }
  if (u.origin.length > 300) return { ok: false, error: 'The box URL is too long.' };
  return { ok: true, value: u.origin };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

export type BanInput = {
  kind?: 'disable' | 'archive';
  emails?: string[];
  issuer?: string | null;
  oid?: string | null;
  reason?: string | null;
};

/** A ban's keys, checked: lowercase emails (at least one key), and the
 *  company sign-in issuer and object id both or neither. */
export function checkBan(input: BanInput): Checked<Required<BanInput> & BanKeys> {
  const emails = [...new Set((input.emails ?? []).map((e) => e.trim().toLowerCase()))].filter(
    (e) => e.length > 0,
  );
  if (emails.length > CONTROL_MAX_BAN_EMAILS) {
    return { ok: false, error: `A ban names at most ${CONTROL_MAX_BAN_EMAILS} emails.` };
  }
  const bad = emails.find((e) => !EMAIL.test(e) || e.length > 254);
  if (bad !== undefined) return { ok: false, error: 'Each email must be a valid address.' };
  const issuer = input.issuer?.trim() || null;
  const oid = input.oid?.trim().toLowerCase() || null;
  if ((issuer === null) !== (oid === null)) {
    return { ok: false, error: 'Give the sign-in issuer and object id together, or neither.' };
  }
  if (issuer !== null && (!/^https:\/\/\S+$/.test(issuer) || issuer.length > 300)) {
    return { ok: false, error: 'The sign-in issuer must be an https URL.' };
  }
  if (oid !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(oid)) {
    return { ok: false, error: 'The object id has characters it cannot have.' };
  }
  if (emails.length === 0 && oid === null) {
    return { ok: false, error: 'A ban needs an email, or a sign-in issuer and object id.' };
  }
  const reason = input.reason?.trim().slice(0, 500) || null;
  return { ok: true, value: { kind: input.kind ?? 'disable', emails, issuer, oid, reason } };
}

// --- the match ---------------------------------------------------------------

export function loginMatches(login: ControlLogin, ban: BanKeys): boolean {
  if (ban.emails.includes(login.email.toLowerCase())) return true;
  if (ban.issuer === null || ban.oid === null) return false;
  const oid = ban.oid.toLowerCase();
  return login.links.some((l) => l.issuer === ban.issuer && l.oid.toLowerCase() === oid);
}

export type BoxPlan = {
  disable: string[];
  archive: string[];
  enable: string[];
  /** Matched by an active ban and the box owner: never disabled. */
  owners: string[];
  /** Per active ban: how many logins it matched, and the owner ids. */
  perBan: Map<string, { matched: number; ownerIds: string[] }>;
};

/**
 * What one run asks of one box (plan sections 3.1, 3.5, 3.6), from its
 * login list and the bans:
 *  - archive: matched by an active archive ban, not yet archived;
 *  - disable: matched by an active disable ban, still enabled;
 *  - enable: disabled by the CC (its marker still holds), matched by a
 *    lifted disable ban, and by no active ban. The box checks the marker
 *    again; a lifted (retired) archive ban never enables.
 * The box owner is never in any list: it is reported instead.
 */
export function planBox(logins: readonly ControlLogin[], bans: readonly ControlBan[]): BoxPlan {
  const active = bans.filter((b) => b.liftedAt === null);
  const lifted = bans.filter((b) => b.liftedAt !== null && b.kind === 'disable');
  const plan: BoxPlan = { disable: [], archive: [], enable: [], owners: [], perBan: new Map() };
  for (const b of active) plan.perBan.set(b.id, { matched: 0, ownerIds: [] });
  for (const l of logins) {
    const hits = active.filter((b) => loginMatches(l, b));
    for (const b of hits) {
      const r = plan.perBan.get(b.id)!;
      r.matched++;
      if (l.owner) r.ownerIds.push(l.id);
    }
    if (hits.length > 0) {
      if (l.owner) plan.owners.push(l.id);
      else if (hits.some((b) => b.kind === 'archive')) {
        if (!l.archived) plan.archive.push(l.id);
      } else if (!l.disabled) plan.disable.push(l.id);
      continue;
    }
    if (l.marked && !l.archived && !l.owner && lifted.some((b) => loginMatches(l, b))) {
      plan.enable.push(l.id);
    }
  }
  return plan;
}

// --- boxes -------------------------------------------------------------------

export type BoxView = Omit<ControlBox, 'logins'> & { loginCount: number | null };

function boxView(row: ControlBox): BoxView {
  const { logins, ...rest } = row;
  return { ...rest, loginCount: logins ? logins.length : null };
}

export async function listControlBoxes(): Promise<BoxView[]> {
  const rows = await db.select().from(controlBoxes).orderBy(asc(controlBoxes.url));
  return rows.map(boxView);
}

/** Adds a box (its first run is asked for at once). Null when the URL is
 *  already linked. */
export async function addControlBox(
  url: string,
  label: string | null,
  addedBy: string,
): Promise<BoxView | null> {
  const rows = await db
    .insert(controlBoxes)
    .values({
      url,
      label: label?.trim().slice(0, 100) || null,
      addedBy,
      runRequestedAt: sql`now()`,
    })
    .onConflictDoNothing({ target: controlBoxes.url })
    .returning();
  return rows[0] ? boxView(rows[0]) : null;
}

/** Stops every call to the box. The box keeps what was done there. */
export async function removeControlBox(id: string): Promise<boolean> {
  const rows = await db
    .delete(controlBoxes)
    .where(eq(controlBoxes.id, id))
    .returning({ id: controlBoxes.id });
  return rows.length > 0;
}

/** Asks the control service for a run now, of one box or of all. */
export async function requestControlRun(boxId?: string): Promise<void> {
  await db
    .update(controlBoxes)
    .set({ runRequestedAt: sql`now()` })
    .where(boxId ? eq(controlBoxes.id, boxId) : sql`true`);
}

// --- bans --------------------------------------------------------------------

export type BanPreview = {
  boxes: {
    boxId: string;
    url: string;
    label: string | null;
    matched: number | null;
    owners: number;
  }[];
  /** Boxes with no login list yet (never run, or never answered). */
  unknown: number;
};

/** What a new ban would match, from each box's last login list. A
 *  preview, not a check: the run itself reads the lists afresh. */
export async function previewControlBan(keys: BanKeys): Promise<BanPreview> {
  const rows = await db.select().from(controlBoxes).orderBy(asc(controlBoxes.url));
  const out: BanPreview = { boxes: [], unknown: 0 };
  for (const r of rows) {
    if (!r.logins) {
      out.unknown++;
      out.boxes.push({ boxId: r.id, url: r.url, label: r.label, matched: null, owners: 0 });
      continue;
    }
    const hits = r.logins.filter((l) => loginMatches(l, keys));
    out.boxes.push({
      boxId: r.id,
      url: r.url,
      label: r.label,
      matched: hits.length,
      owners: hits.filter((l) => l.owner).length,
    });
  }
  return out;
}

export async function makeControlBan(
  ban: { kind: 'disable' | 'archive'; reason: string | null } & BanKeys,
  madeBy: string,
): Promise<ControlBan> {
  const [row] = await db
    .insert(controlBans)
    .values({ ...ban, madeBy })
    .returning();
  await requestControlRun();
  return row!;
}

export type BanView = ControlBan & {
  boxesMatched: number;
  loginsMatched: number;
  ownerIds: string[];
};

export async function listControlBans(opts: { lifted?: boolean } = {}): Promise<BanView[]> {
  const bans = await db
    .select()
    .from(controlBans)
    .where(opts.lifted ? undefined : isNull(controlBans.liftedAt))
    .orderBy(desc(controlBans.madeAt))
    .limit(500);
  if (bans.length === 0) return [];
  const results = await db
    .select()
    .from(controlResults)
    .where(
      inArray(
        controlResults.banId,
        bans.map((b) => b.id),
      ),
    );
  return bans.map((b) => {
    const mine = results.filter((r) => r.banId === b.id);
    return {
      ...b,
      boxesMatched: mine.filter((r) => r.matched > 0).length,
      loginsMatched: mine.reduce((n, r) => n + r.matched, 0),
      ownerIds: mine.flatMap((r) => r.ownerIds),
    };
  });
}

/** Lifts a ban (an archive ban is retired: its runs stop, nothing is
 *  enabled). Null when there is no such ban still active. */
export async function liftControlBan(id: string, liftedBy: string): Promise<ControlBan | null> {
  const [row] = await db
    .update(controlBans)
    .set({ liftedAt: sql`now()`, liftedBy })
    .where(and(eq(controlBans.id, id), isNull(controlBans.liftedAt)))
    .returning();
  if (!row) return null;
  await requestControlRun();
  return row;
}

/** Per box: what each active ban matched there (the Fleet results). */
export async function listControlResults() {
  return db
    .select({
      banId: controlResults.banId,
      boxId: controlResults.boxId,
      matched: controlResults.matched,
      ownerIds: controlResults.ownerIds,
      updatedAt: controlResults.updatedAt,
    })
    .from(controlResults)
    .innerJoin(controlBans, eq(controlBans.id, controlResults.banId))
    .where(isNull(controlBans.liftedAt));
}

// --- the control service's row -----------------------------------------------

/** A short fingerprint of a key line: the first 16 hex characters of its
 *  sha256. The service logs it at boot; the Fleet screen shows it. */
export function keyFingerprint(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16);
}

export async function controlServiceState(): Promise<{
  publicKey: string;
  fingerprint: string;
  lastTickAt: Date | null;
} | null> {
  const [row] = await db.select().from(controlService).limit(1);
  if (!row) return null;
  return {
    publicKey: row.publicKey,
    fingerprint: keyFingerprint(row.publicKey),
    lastTickAt: row.lastTickAt,
  };
}

// --- the control service's own reads and writes ------------------------------

/** The service's key line, written at its start. */
export async function saveControlServiceKey(publicKey: string): Promise<void> {
  await db
    .insert(controlService)
    .values({ id: true, publicKey, lastTickAt: sql`now()` })
    .onConflictDoUpdate({
      target: controlService.id,
      set: { publicKey, lastTickAt: sql`now()`, updatedAt: sql`now()` },
    });
}

export async function noteControlTick(): Promise<void> {
  await db.update(controlService).set({ lastTickAt: sql`now()` });
}

/** The boxes due a run: asked for, or not run for CONTROL_RUN_EVERY_MS.
 *  The ask is taken (cleared) as they are read. */
export async function takeDueControlBoxes(): Promise<ControlBox[]> {
  const cutoff = new Date(Date.now() - CONTROL_RUN_EVERY_MS);
  return db
    .update(controlBoxes)
    .set({ runRequestedAt: null })
    .where(
      or(
        isNotNull(controlBoxes.runRequestedAt),
        isNull(controlBoxes.lastRunAt),
        lte(controlBoxes.lastRunAt, cutoff),
      ),
    )
    .returning();
}

/** The bans a run reads: the active ones, and the lifted disable bans (for
 *  the enable of what they disabled). */
export async function runControlBans(): Promise<ControlBan[]> {
  return db
    .select()
    .from(controlBans)
    .where(or(isNull(controlBans.liftedAt), eq(controlBans.kind, 'disable')));
}

export async function saveControlRun(
  boxId: string,
  run: {
    reason: string | null;
    result?: Record<string, unknown>;
    logins?: ControlLogin[];
    perBan?: BoxPlan['perBan'];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(controlBoxes)
      .set({
        lastRunAt: sql`now()`,
        lastReason: run.reason,
        ...(run.reason === null ? { lastOkAt: sql`now()` } : {}),
        ...(run.result ? { lastResult: run.result } : {}),
        ...(run.logins ? { logins: run.logins } : {}),
      })
      .where(eq(controlBoxes.id, boxId));
    if (!run.perBan) return;
    for (const [banId, r] of run.perBan) {
      await tx
        .insert(controlResults)
        .values({ banId, boxId, matched: r.matched, ownerIds: r.ownerIds })
        .onConflictDoUpdate({
          target: [controlResults.banId, controlResults.boxId],
          set: { matched: r.matched, ownerIds: r.ownerIds, updatedAt: sql`now()` },
        });
    }
  });
}
