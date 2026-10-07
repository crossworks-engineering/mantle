/**
 * Inbound API keys (migration 0232, plan page 1e62e204).
 *
 * A key acts as the ONE login that made it (an admin, a member or a
 * client; nobody makes a key for another login) and can only narrow what
 * that login may do: `access` is read or read_write, `areas`
 * names the parts of the brain it may touch (null = all). It is accepted as
 * a Bearer on /api/v1/* (the gate, server/middleware/gate.ts) and on
 * /api/mcp (lib/mcp-auth.ts), and nowhere else.
 *
 * The secret has the shape `mtlk_<prefix>_<secret>`. The prefix is public:
 * the lookup key and what the UI shows. Only the SHA-256 of the whole value
 * is stored, and the stored hash is compared in constant time. SHA-256 (not
 * bcrypt) is enough because the secret part is 32 random bytes.
 *
 * Every rule is read from the rows on every request: the key row (revoked,
 * expired) and the login row (disabled, role, and for a client key the
 * session epoch). A disable or a role change ends every key of the login.
 * An admin's or member's key outlives a plain sign-out (audit item 9); a
 * password change, "sign out everywhere", an admin's End sessions and a
 * reused device token revoke every key of the login (endLoginSessions
 * `endKeys`). A client has no password to re-type, so a client key ends
 * with the session it was made in (M2 audit N5).
 *
 * The secret is never logged and never returned after create.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { accessKeys, db, isUniqueViolation, isWriteRefused } from '@mantle/db';
import { KEY_AREAS, type KeyArea } from '@mantle/mcp-core/key-scope';
import { loadLoginRow, type LoginRow } from './auth/login-row';
import { auditFireAndForget } from './audit';
import { rateLimit, rateLimitFlood, rateLimitFloodPeek, type RateLimitResult } from './rate-limit';

export const ACCESS_KEY_PREFIX = 'mtlk_';

/** The parts of the brain a key can be limited to. Each /api/v1 route
 *  (lib/api-v1.ts) and each MCP tool (@mantle/mcp-core/key-scope) maps to
 *  at most one of them. One list for both surfaces. */
export const ACCESS_KEY_AREAS = KEY_AREAS;
export type AccessKeyArea = KeyArea;

export const ACCESS_KEY_ACCESS = ['read', 'read_write'] as const;
export type AccessKeyAccess = (typeof ACCESS_KEY_ACCESS)[number];

export type AccessKeyRole = 'admin' | 'member' | 'client';

/** The expiry a new key gets when the caller names none. */
export const DEFAULT_ACCESS_KEY_EXPIRY_DAYS = 90;
/** The longest expiry a caller may name (in days). "Never" is null. */
export const MAX_ACCESS_KEY_EXPIRY_DAYS = 3650;
/** The longest a member's or client's key may live, in days (M2 audit F4).
 *  An admin re-types their password to make a key and may pick "never". A
 *  member re-types theirs too, but a member key ends within 90 days. A
 *  client signs in with a link or a code and has no password to re-type, so
 *  a client key ends within 30 days, as a client session does. */
export const MAX_KEY_DAYS_BY_ROLE: Record<AccessKeyRole, number | null> = {
  admin: null,
  member: 90,
  client: 30,
};
/** Whether a role re-types its password to make a key (a client has none). */
export function keyNeedsPassword(role: AccessKeyRole): boolean {
  return role !== 'client';
}
/** Live (not revoked, not expired) keys one login may hold. */
export const MAX_LIVE_KEYS_PER_LOGIN = 50;

/** Requests a minute per key: the public HTTP API, and /api/mcp.
 *
 *  The per-address budgets below key on `clientIp`: the address the
 *  reverse proxy appends to X-Forwarded-For (audit item 10). A brain served
 *  WITHOUT its proxy (Caddy in the release) takes that address from the
 *  caller, who can then claim a fresh one per request. Run behind the
 *  proxy; the docs say so (docs/guide/07-api). */
export const ACCESS_KEY_RATE = {
  v1: { max: 120, windowMs: 60_000 },
  mcp: { max: 300, windowMs: 60_000 },
} as const;
/** Requests a minute per LOGIN across all its keys (M2 audit F7): 50 keys
 *  must not buy 50 times the budget. */
const LOGIN_KEY_RATE = {
  v1: { max: 600, windowMs: 60_000 },
  mcp: { max: 1200, windowMs: 60_000 },
} as const;
/** GET /api/v1/search embeds the query on every call: its own smaller
 *  budget per key (M2 audit, suspected item 2). */
const SEARCH_KEY_RATE = { max: 30, windowMs: 60_000 };
/** Failed key presentations a minute from one address, any prefix (M2
 *  audit F3), checked before the database is asked: random prefixes cost
 *  a lookup each. High enough that a shared address (NAT) with one broken
 *  script does not lock its neighbours out, low enough to cap the cost. */
const FAILED_KEY_ADDRESS_RATE = { max: 100, windowMs: 60_000 };
/** Failed presentations a minute of one key prefix from one address. Keyed
 *  on the pair, not the address alone (audit item 2): bad keys from a shared
 *  address (NAT, a proxy) must not lock every valid key out from it. Only a
 *  caller who tries wrong secrets for THIS prefix from THIS address meets
 *  it. The peek before the check and the count after it can race by the
 *  number of requests in flight (audit item 7): accepted, the secret is 256
 *  random bits. */
const FAILED_KEY_RATE = { max: 20, windowMs: 60_000 };

const PREFIX_LEN = 8;
const SECRET_BYTES = 32;
const PREFIX_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** `mtlk_` + 8 prefix characters + `_` + 43 base64url characters. */
const KEY_RE = /^mtlk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

/** What a verified key grants: who it acts as and how far. */
export type AccessKeyGrant = {
  id: string;
  prefix: string;
  name: string;
  loginId: string;
  role: AccessKeyRole;
  access: AccessKeyAccess;
  /** null = every area. */
  areas: readonly AccessKeyArea[] | null;
  riskyTools: readonly string[];
  /** The admin who made the key (null once that login is deleted). Every
   *  write made with the key names it in the audit trail. */
  createdBy: string | null;
  /** The login row the key was checked against on this request. */
  login: LoginRow;
};

export type AccessKeyRefusal = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'login';

export type AccessKeyCheck =
  { ok: true; grant: AccessKeyGrant } | { ok: false; reason: AccessKeyRefusal; keyId?: string };

export function isAccessKey(token: string | null | undefined): token is string {
  return typeof token === 'string' && token.startsWith(ACCESS_KEY_PREFIX);
}

/** Whether a path is on the public, versioned HTTP API. */
export function isApiV1Path(path: string): boolean {
  return path === '/api/v1' || path.startsWith('/api/v1/');
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function randomPrefix(): string {
  const bytes = randomBytes(PREFIX_LEN);
  let out = '';
  for (const b of bytes) out += PREFIX_ALPHABET[b % PREFIX_ALPHABET.length];
  return out;
}

function isArea(v: string): v is AccessKeyArea {
  return (ACCESS_KEY_AREAS as readonly string[]).includes(v);
}

function isRole(v: string): v is AccessKeyRole {
  return v === 'admin' || v === 'member' || v === 'client';
}

/** A login row may use a key only while it may hold a session. */
function loginUsable(row: LoginRow): boolean {
  return !!row.email && !row.disabledAt;
}

/**
 * Check a presented key: its shape, the row its prefix names, the hash (in
 * constant time), revoke and expiry, and the login it acts as (usable, the
 * same role). No side effects: the caller touches,
 * rate-limits and audits.
 */
export async function verifyAccessKey(token: string): Promise<AccessKeyCheck> {
  const m = KEY_RE.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [row] = await db.select().from(accessKeys).where(eq(accessKeys.keyPrefix, m[1]!)).limit(1);
  const presented = sha256(token);
  if (!row) return { ok: false, reason: 'unknown' };
  const stored = Buffer.from(row.keyHash, 'hex');
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    return { ok: false, reason: 'unknown' };
  }
  if (row.revokedAt) return { ok: false, reason: 'revoked', keyId: row.id };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired', keyId: row.id };
  }
  const login = await loadLoginRow(row.loginId);
  if (
    !login ||
    !loginUsable(login) ||
    !isRole(row.loginRole) ||
    login.role !== row.loginRole ||
    // A client key lives as long as the session it was made in (N5).
    (row.loginRole === 'client' && row.sessionEpoch !== login.sessionEpoch)
  ) {
    return { ok: false, reason: 'login', keyId: row.id };
  }
  return {
    ok: true,
    grant: {
      id: row.id,
      prefix: row.keyPrefix,
      name: row.name,
      loginId: row.loginId,
      role: row.loginRole,
      access: row.access === 'read_write' ? 'read_write' : 'read',
      areas: row.areas ? row.areas.filter(isArea) : null,
      riskyTools: row.loginRole === 'admin' ? row.riskyTools : [],
      createdBy: row.createdBy,
      login,
    },
  };
}

// ── Use: rate limits, last use, refusals ─────────────────────────────────────

/** Take one request from the key's budget on `surface`, and from its
 *  login's budget across every key (F7). Both must allow it. */
export function rateLimitAccessKey(
  grant: Pick<AccessKeyGrant, 'id' | 'loginId'>,
  surface: 'v1' | 'mcp',
): RateLimitResult {
  const key = rateLimit(`akey:${surface}:${grant.id}`, ACCESS_KEY_RATE[surface]);
  if (!key.ok) return key;
  return rateLimit(`akey-login:${surface}:${grant.loginId}`, LOGIN_KEY_RATE[surface]);
}

/** The extra budget of GET /api/v1/search for one key. */
export function rateLimitKeySearch(keyId: string): RateLimitResult {
  return rateLimit(`akey-search:${keyId}`, SEARCH_KEY_RATE);
}

/** The failed-try bucket of a presented key: its address and its prefix
 *  (a malformed key shares one bucket per address). */
function failKey(ipKey: string, token: string): string {
  return `akey-fail:${ipKey}:${KEY_RE.exec(token)?.[1] ?? '-'}`;
}

/** Whether the address may present this key again: its failures across
 *  every prefix (F3), then for this prefix (item 2). Peeked only: a failure
 *  is counted by countFailedKey. `ipKey` is `clientIpKey(req)`: an IPv6
 *  /64 is one address (M2 audit N1), so rotating addresses inside it buys
 *  nothing. The buckets live in the flood pool (lib/rate-limit.ts). */
export function failedKeyBudget(ipKey: string, token: string): RateLimitResult {
  const address = rateLimitFloodPeek(`akey-fail-addr:${ipKey}`, FAILED_KEY_ADDRESS_RATE);
  if (!address.ok) return address;
  return rateLimitFloodPeek(failKey(ipKey, token), FAILED_KEY_RATE);
}

/** Count one failed presentation of this key's prefix from the address. */
export function countFailedKey(ipKey: string, token: string): void {
  rateLimitFlood(`akey-fail-addr:${ipKey}`, FAILED_KEY_ADDRESS_RATE);
  rateLimitFlood(failKey(ipKey, token), FAILED_KEY_RATE);
}

const TOUCH_EVERY_MS = 60_000;
const lastTouch = new Map<string, number>();

/** Stamp a key's last use, at most once a minute per key. Best effort: a
 *  brain that refuses writes still answers the request. */
export function touchAccessKey(keyId: string, ip: string | null): void {
  const now = Date.now();
  if (now - (lastTouch.get(keyId) ?? 0) < TOUCH_EVERY_MS) return;
  if (lastTouch.size >= 10_000) lastTouch.clear();
  lastTouch.set(keyId, now);
  void db
    .update(accessKeys)
    .set({ lastUsedAt: new Date(now), lastUsedIp: ip && ip !== 'unknown' ? ip : null })
    .where(eq(accessKeys.id, keyId))
    .catch((err) => {
      if (!isWriteRefused(err)) console.error('[access-keys] last-use stamp failed:', err);
    });
}

const REFUSAL_AUDIT_EVERY_MS = 60_000;
const lastRefusalAudit = new Map<string, number>();

/**
 * Record a refused use of a KNOWN key (revoked, expired, its login ended,
 * or outside its scope), at most one row a minute per key: a script that
 * loops on a dead key must not fill the audit log. Unknown and malformed
 * keys name no row and are not recorded (they only cost the caller's
 * address its failed-try budget).
 */
export function auditKeyRefusal(input: {
  keyId: string;
  reason: string;
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
}): void {
  const now = Date.now();
  if (now - (lastRefusalAudit.get(input.keyId) ?? 0) < REFUSAL_AUDIT_EVERY_MS) return;
  if (lastRefusalAudit.size >= 10_000) lastRefusalAudit.clear();
  lastRefusalAudit.set(input.keyId, now);
  auditFireAndForget({
    actorId: null,
    actorEmail: 'api-key',
    action: 'key.refused',
    method: input.method,
    path: input.path,
    ip: input.ip,
    userAgent: input.userAgent,
    detail: { keyId: input.keyId, reason: input.reason },
  });
}

// ── Mint ─────────────────────────────────────────────────────────────────────

export type MintAccessKeyInput = {
  name: string;
  loginId: string;
  loginRole: AccessKeyRole;
  access: AccessKeyAccess;
  areas: readonly AccessKeyArea[] | null;
  riskyTools: readonly string[];
  expiresAt: Date | null;
  createdBy: string;
  /** A client's session epoch now; null for an admin or member key. */
  sessionEpoch: number | null;
  /** Refuse (null) when the login already holds this many live keys. */
  maxLive: number;
};

/** Mint a key. The plaintext is returned ONCE; only its hash is kept. Null
 *  when the login already holds `maxLive` live keys: the count and the
 *  insert run in one transaction under a per-login lock, so two creates at
 *  once cannot both pass the cap (M2 audit F7). */
export async function mintAccessKey(
  input: MintAccessKeyInput,
): Promise<{ id: string; prefix: string; key: string } | null> {
  const areas = input.areas ? [...new Set(input.areas)].sort() : null;
  const riskyTools = input.loginRole === 'admin' ? [...new Set(input.riskyTools)].sort() : [];
  // A prefix clash is about 1 in 10^14; try again rather than fail.
  for (let attempt = 0; ; attempt++) {
    const prefix = randomPrefix();
    const key = `${ACCESS_KEY_PREFIX}${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`;
    try {
      const row = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`access-keys:${input.loginId}`}))`,
        );
        const [live] = await tx
          .select({ n: count() })
          .from(accessKeys)
          .where(
            and(
              eq(accessKeys.loginId, input.loginId),
              isNull(accessKeys.revokedAt),
              or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, new Date())),
            ),
          );
        if (Number(live?.n ?? 0) >= input.maxLive) return null;
        const [inserted] = await tx
          .insert(accessKeys)
          .values({
            name: input.name,
            loginId: input.loginId,
            loginRole: input.loginRole,
            keyPrefix: prefix,
            keyHash: sha256(key).toString('hex'),
            access: input.access,
            areas,
            riskyTools,
            expiresAt: input.expiresAt,
            createdBy: input.createdBy,
            sessionEpoch: input.loginRole === 'client' ? input.sessionEpoch : null,
          })
          .returning({ id: accessKeys.id });
        return inserted!;
      });
      return row ? { id: row.id, prefix, key } : null;
    } catch (err) {
      if (attempt < 3 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

/** The expiry for a create request: `undefined` = the default, `null` =
 *  never, a number = that many days from now. */
export function expiryFromDays(days: number | null | undefined, now = Date.now()): Date | null {
  if (days === null) return null;
  const d = days ?? DEFAULT_ACCESS_KEY_EXPIRY_DAYS;
  return new Date(now + d * 24 * 60 * 60 * 1000);
}
