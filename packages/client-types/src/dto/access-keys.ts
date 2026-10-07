/**
 * Inbound API keys on the wire (migration 0232, plan page 1e62e204): the
 * Settings > API access screen, and the public API v1 answers about keys.
 *
 * A key acts as ONE login (admin, member or client) and can only narrow
 * it: `access` (read or read_write) and `areas` (null = every area). It is
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

/** A login the caller may make a key for: their own, or a member or a
 *  client. Never another admin. */
export type AccessKeyLoginOption = {
  id: string;
  email: string;
  displayName: string | null;
  role: AccessKeyRole;
};

/** GET /api/access-keys (owner or admin only). */
export type AccessKeyList = {
  keys: AccessKeyView[];
  logins: AccessKeyLoginOption[];
  areas: AccessKeyArea[];
  /** The expiry a key gets when the create names none. */
  defaultExpiryDays: number;
};

/** POST /api/access-keys body. */
export type AccessKeyCreateInput = {
  name: string;
  loginId: string;
  access: AccessKeyAccess;
  /** null = every area; else at least one. */
  areas: AccessKeyArea[] | null;
  /** Omitted = the default (90); null = never; else 1 to 3650 days. */
  expiresInDays?: number | null;
  /** Only for a key that acts as an admin. */
  riskyTools?: string[];
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
