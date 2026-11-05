/**
 * The SCIM 2.0 shapes (RFC 7643, RFC 7644; docs/scim.md): what a provider
 * sends and what the brain answers, pure. A login is a SCIM User: its id is
 * the login's id, userName its email, displayName its name, active "not
 * disabled", externalId the provider's own id for the person.
 *
 * Read the way Entra ID and Okta send it, not only the way the RFC writes
 * it: an op name in any case (`Replace`, `replace`), a boolean as a string
 * (`"False"`), a PATCH with no path whose value is an object, and a path
 * with the core schema's URN in front. An attribute the brain does not keep
 * (name parts, emails, title, the enterprise extension) is accepted and
 * left alone, so a provider that maps more than Mantle keeps never fails a
 * whole change on it; that matters most for a disable, which rides in the
 * same PATCH as whatever else changed.
 */
import { z } from 'zod';

export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_CONTENT_TYPE = 'application/scim+json';

/** The longest display name a login keeps (the Users screen's). */
export const DISPLAY_NAME_MAX = 120;
/** The longest externalId kept (0359's check). */
export const EXTERNAL_ID_MAX = 255;
/** A list answers at most this many per page. */
export const LIST_MAX = 200;

/** What a SCIM error body says (RFC 7644 section 3.12). */
export type ScimErrorBody = {
  schemas: [typeof SCIM_ERROR];
  status: string;
  scimType?: string;
  detail: string;
};

export function scimErrorBody(status: number, detail: string, scimType?: string): ScimErrorBody {
  return {
    schemas: [SCIM_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** A login as the SCIM routes read it. */
export type ScimLogin = Readonly<{
  id: string;
  email: string;
  displayName: string | null;
  disabled: boolean;
  externalId: string | null;
  createdAt: Date;
}>;

/** A login as a SCIM User. `base` is the box's /scim/v2 URL, or '' to
 *  leave `meta.location` relative. */
export function toScimUser(l: ScimLogin, base: string) {
  return {
    schemas: [SCIM_USER],
    id: l.id,
    ...(l.externalId ? { externalId: l.externalId } : {}),
    userName: l.email,
    ...(l.displayName ? { displayName: l.displayName, name: { formatted: l.displayName } } : {}),
    active: !l.disabled,
    emails: [{ value: l.email, type: 'work', primary: true }],
    meta: {
      resourceType: 'User',
      created: l.createdAt.toISOString(),
      location: `${base}/Users/${l.id}`,
    },
  };
}

export function listBody(resources: unknown[], total: number, startIndex: number) {
  return {
    schemas: [SCIM_LIST],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** The one filter a list reads: `<attr> eq "<value>"`. */
export type ScimFilter = Readonly<{ attr: 'userName' | 'externalId' | 'id'; value: string }>;

const FILTER_RE = /^\s*(userName|externalId|id)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

/**
 * The filter, or null for none, or 'bad' for one the brain does not read
 * (a 400 invalidFilter: never a list of everyone in place of a match).
 */
export function parseFilter(raw: string | null): ScimFilter | null | 'bad' {
  if (raw === null || raw.trim() === '') return null;
  const m = FILTER_RE.exec(raw);
  if (!m) return 'bad';
  const name = m[1]!.toLowerCase();
  const attr = name === 'username' ? 'userName' : name === 'externalid' ? 'externalId' : 'id';
  return { attr, value: m[2]!.replace(/\\(.)/g, '$1') };
}

/** The highest startIndex read (an OFFSET past it is past every login). */
const START_MAX = 1_000_000_000;

/** startIndex (1-based) and count of a list, bounded. */
export function parsePage(q: URLSearchParams): { startIndex: number; count: number } {
  const int = (v: string | null, d: number) => {
    const n = v === null ? NaN : Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  return {
    startIndex: Math.min(START_MAX, Math.max(1, int(q.get('startIndex'), 1))),
    count: Math.min(LIST_MAX, Math.max(0, int(q.get('count'), 100))),
  };
}

/** A SCIM boolean: true, false, or the strings Entra sends ("True",
 *  "False"); anything else undefined. */
export function scimBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

/** What a create, a replace or a patch asks of a login. `undefined`
 *  leaves a field as it is; `null` clears it. */
export type ScimChange = {
  userName?: string;
  displayName?: string | null;
  externalId?: string | null;
  active?: boolean;
};

/** Why a part of a request was not applied: its SCIM error. */
export type Problem = { detail: string; scimType: string };

/**
 * A parse: the change, and the first attribute it could not read
 * (`problem`), or no change at all (`ok: false`, a body that is no SCIM
 * object). An attribute the brain cannot read is left out of the change
 * and named in `problem`, so the rest still applies: above all a disable
 * in the same request (the service answers the problem after it).
 */
export type Parsed<T> = { ok: true; value: T; problem?: Problem } | ({ ok: false } & Problem);

const problem = (detail: string, scimType = 'invalidValue'): Problem => ({ detail, scimType });
const refused = (detail: string, scimType = 'invalidSyntax'): { ok: false } & Problem => ({
  ok: false,
  detail,
  scimType,
});

const Email = z.string().trim().toLowerCase().email().max(320);

/** A display name as a login keeps it: one line of visible text (no
 *  control or format characters, so no bidi trick), trimmed, at most
 *  DISPLAY_NAME_MAX characters; empty is null. */
function displayNameOf(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const one = v
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one === '' ? null : one.slice(0, DISPLAY_NAME_MAX);
}

/** An externalId: a string of 1 to EXTERNAL_ID_MAX characters, or null
 *  (none); undefined when it is neither. */
function externalIdOf(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > EXTERNAL_ID_MAX) return undefined;
  return v;
}

const EXTERNAL_ID_PROBLEM = `externalId must be a string of at most ${EXTERNAL_ID_MAX} characters.`;

/** The userName a provider sent, lower case, or undefined. Read only to
 *  note a rename (the service keeps the email), never checked. */
function userNameOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v.trim().toLowerCase() : undefined;
}

/** The display name a provider means: displayName, else name.formatted,
 *  else the given and family names. */
function wantedDisplayName(o: Record<string, unknown>): string | null | undefined {
  const direct = displayNameOf(o.displayName);
  if (direct !== undefined) return direct;
  const name = o.name;
  if (name && typeof name === 'object') {
    const n = name as Record<string, unknown>;
    const formatted = displayNameOf(n.formatted);
    if (formatted) return formatted;
    const parts = [n.givenName, n.familyName].filter((p) => typeof p === 'string' && p.trim());
    if (parts.length > 0) return displayNameOf(parts.join(' '));
  }
  return undefined;
}

/**
 * A User body. A create (POST) needs userName as an email (a login signs
 * in by its email), and `active` absent means active. A replace (PUT)
 * reads userName only to note a rename, and `active` absent leaves the
 * login as it is.
 */
export function parseUserBody(body: unknown, mode: 'create' | 'replace'): Parsed<ScimChange> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refused('Send a User object.');
  }
  const o = body as Record<string, unknown>;
  const value: ScimChange = {};
  let first: Problem | undefined;
  const note = (p: Problem) => {
    first ??= p;
  };
  if (mode === 'create') {
    const email = Email.safeParse(o.userName);
    if (!email.success)
      return refused("userName must be the person's email address.", 'invalidValue');
    value.userName = email.data;
    value.active = true;
  } else {
    const u = userNameOf(o.userName);
    if (u !== undefined) value.userName = u;
  }
  if (o.active !== undefined) {
    const b = scimBool(o.active);
    if (b === undefined) note(problem('active must be true or false.'));
    else value.active = b;
  }
  const name = wantedDisplayName(o);
  if (name !== undefined) value.displayName = name;
  if (o.externalId !== undefined) {
    const ext = externalIdOf(o.externalId);
    if (ext === undefined) note(problem(EXTERNAL_ID_PROBLEM));
    else value.externalId = ext;
  }
  return first ? { ok: true, value, problem: first } : { ok: true, value };
}

/** A PATCH path without the core schema's URN, lower case. */
function pathKey(path: string): string {
  const p = path.trim();
  const urn = `${SCIM_USER}:`;
  return (p.toLowerCase().startsWith(urn.toLowerCase()) ? p.slice(urn.length) : p).toLowerCase();
}

/** Apply one attribute of a PATCH to `out`: null when done (or left
 *  alone: an attribute the brain does not keep, see the header), else why
 *  it was not. */
function patchAttr(out: ScimChange, key: string, v: unknown, remove: boolean): Problem | null {
  switch (key) {
    case 'active': {
      if (remove) return null;
      const b = scimBool(v);
      if (b === undefined) return problem('active must be true or false.');
      out.active = b;
      return null;
    }
    case 'displayname':
    case 'name.formatted': {
      if (key === 'name.formatted' && out.displayName !== undefined) return null;
      const n = remove ? null : displayNameOf(v);
      if (n === undefined) return problem('displayName must be a string.');
      out.displayName = n;
      return null;
    }
    case 'externalid': {
      const ext = externalIdOf(remove ? null : v);
      if (ext === undefined) return problem(EXTERNAL_ID_PROBLEM);
      out.externalId = ext;
      return null;
    }
    case 'username': {
      const u = remove ? undefined : userNameOf(v);
      if (u !== undefined) out.userName = u;
      return null;
    }
    default:
      return null;
  }
}

/**
 * A PatchOp body: its operations folded into one change, in order (a later
 * operation on the same attribute wins). An operation the brain cannot
 * read is left out and named as the problem; the others still apply.
 */
export function parsePatch(body: unknown): Parsed<ScimChange> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refused('Send a PatchOp object.');
  }
  const ops = (body as Record<string, unknown>).Operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100) {
    return refused('Operations must hold 1 to 100 operations.');
  }
  const out: ScimChange = {};
  let first: Problem | undefined;
  const note = (p: Problem | null) => {
    if (p) first ??= p;
  };
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      note(problem('An operation must be an object.', 'invalidSyntax'));
      continue;
    }
    const op = raw as Record<string, unknown>;
    const name = typeof op.op === 'string' ? op.op.trim().toLowerCase() : '';
    if (name !== 'add' && name !== 'replace' && name !== 'remove') {
      note(problem('op must be add, replace or remove.', 'invalidSyntax'));
      continue;
    }
    const remove = name === 'remove';
    if (typeof op.path === 'string' && op.path.trim() !== '') {
      note(patchAttr(out, pathKey(op.path), op.value, remove));
      continue;
    }
    if (op.path !== undefined && op.path !== null && typeof op.path !== 'string') {
      note(problem('path must be a string.', 'invalidPath'));
      continue;
    }
    if (remove) {
      note(problem('remove needs a path.', 'noTarget'));
      continue;
    }
    // No path: the value is an object of attributes, each applied as if
    // named by its own path (Entra's `{ "active": false }`).
    const v = op.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      note(problem('An operation with no path needs an object value.'));
      continue;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      note(patchAttr(out, pathKey(k), val, false));
    }
  }
  return first ? { ok: true, value: out, problem: first } : { ok: true, value: out };
}
