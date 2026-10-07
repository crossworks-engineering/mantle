/**
 * Inbound API keys on the wire (migration 0232, plan page 1e62e204): the
 * Settings > API access screen, and the public API v1 answers about keys.
 *
 * A key acts as the ONE login that made it (admin, member or client) and
 * can only narrow it: `access` (read or read_write) and `areas` (null = every area). It is
 * a Bearer on /api/v1/* and /api/mcp, nowhere else. The secret is in the
 * create answer once; no other answer carries it or its hash.
 *
 * The runtime list of areas is this subpath's `ACCESS_KEY_AREAS`
 * (`@crossworks/client-types/dto/access-keys`); the brain pins it to its
 * own list in a test.
 */

/** The parts of the brain a key can be limited to. */
export const ACCESS_KEY_AREAS = [
  'search',
  'pages',
  'notes',
  'tasks',
  'tables',
  'files',
  'calendar',
  'contacts',
  'journal',
  'apps',
] as const;
export type AccessKeyArea = (typeof ACCESS_KEY_AREAS)[number];

export type AccessKeyAccess = 'read' | 'read_write';

export type AccessKeyRole = 'admin' | 'member' | 'client';

export type AccessKeyStatus = 'active' | 'expired' | 'revoked';

/** One key in GET /api/access-keys. Never the secret, never its hash. */
export type AccessKeyView = {
  id: string;
  name: string;
  /** `mtlk_<prefix>`: tells keys apart, useless without the rest. */
  prefix: string;
  /** The login the key acts as. */
  login: { id: string; email: string | null; displayName: string | null; role: AccessKeyRole };
  access: AccessKeyAccess;
  /** null = every area. */
  areas: AccessKeyArea[] | null;
  /** An admin key on /api/mcp: risky tools allowed by name. */
  riskyTools: string[];
  status: AccessKeyStatus;
  /** ISO time; null = never expires. */
  expiresAt: string | null;
  createdAt: string;
  createdBy: { id: string; email: string | null } | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
};

/** GET /api/access-keys. A member or client gets their own keys; an
 *  admin gets every key on the brain. */
export type AccessKeyList = {
  keys: AccessKeyView[];
  /** The caller's role: an admin may name risky tools, and sees every key. */
  role: AccessKeyRole;
  areas: AccessKeyArea[];
  /** The expiry a key gets when the create names none. */
  defaultExpiryDays: number;
  /** The longest expiry the caller may pick, in days; null = any, "never"
   *  included (an admin). A member's keys last at most 90 days, a client's
   *  30. */
  maxExpiryDays: number | null;
  /** Whether the create needs the caller's password (an admin or member;
   *  a client has none). */
  needsPassword: boolean;
};

/** POST /api/access-keys body. The key acts as the caller's own login:
 *  nobody can make a key that acts as another login. */
export type AccessKeyCreateInput = {
  name: string;
  access: AccessKeyAccess;
  /** null = every area; else at least one. */
  areas: AccessKeyArea[] | null;
  /** Omitted = the default (90); null = never; else 1 to 3650 days. */
  expiresInDays?: number | null;
  /** Only for an admin's own key. */
  riskyTools?: string[];
  /** The caller's password, when `needsPassword` (never stored, never
   *  logged). */
  password?: string;
};

/** POST /api/access-keys answer (201). `secret` is shown ONCE. */
export type AccessKeyCreated = {
  id: string;
  prefix: string;
  secret: string;
  expiresAt: string | null;
};

/** The `reason` of a 403 a key gets outside its scope on /api/v1. */
export type AccessKeyScopeRefusal = 'key-area' | 'key-read-only';

/** GET /api/v1/whoami. `key` is set when the caller is an API key. */
export type ApiV1Whoami = {
  role: AccessKeyRole;
  loginId: string;
  email: string;
  displayName: string | null;
  key: {
    id: string;
    prefix: string;
    name: string;
    access: AccessKeyAccess;
    areas: AccessKeyArea[] | null;
  } | null;
};
