/**
 * Access refusals and THE one mapper (workspaces arch plan v2, sections 2
 * and 10; A3c, the gate core). Every refusal, from the gate's own steps or
 * from the database, is read here into what each surface says:
 *
 *  - an HTTP answer: the status and the body, exactly as the routes answer
 *    today (the wire stays { error, reason, message }; a `code` is there
 *    where the route already sends one, A4 adds it to the rest with the
 *    jackdaw pair release);
 *  - a tool's error text, exactly as the tools say it today.
 *
 * The HTTP layer (server/web/server/scope-refusal.ts), the tool error text
 * (databaseErrorPublic, publicToolError) and the gate (@mantle/db gate.ts)
 * read only this. A second mapper is a bug: fold it in here.
 *
 * No package dependencies and no node builtins (the share runtime bundles
 * @mantle/std for the browser). The database's own errors are known by
 * their shape: SQLSTATE 42501, the message of a workspace check, and the
 * edit check's detail.
 */

/** What the gate refuses, by step (plan section 2). */
export type AccessKind =
  /** Step 1: no caller (no session, no key, no token). */
  | 'unauthorized'
  /** Step 3: no declared policy for what is called. */
  | 'unclassified'
  /** Step 4: a surface narrowed the call away (a key's areas or access, a
   *  peer's Write switch or risky tools, the member-app rules, spending on
   *  the owner's keys). */
  | 'narrowed'
  /** Step 5: the call needs the Admin workspace. */
  | 'admin'
  /** Step 5: the call makes a kind that lives in the Admin workspace only. */
  | 'admin-kind'
  /** Step 5: the call needs an Admin area the caller does not have. */
  | 'area'
  /** Step 6: the create home names a workspace the caller may not create in. */
  | 'workspace'
  /** Step 6: the create home's ?ws= is not a workspace id. */
  | 'invalid';

/** The refusal of a tool that belongs to the Admin workspace. */
export const ADMIN_ONLY_ERROR =
  'This tool belongs to the Admin workspace; it does not run in this workspace.';

/** The refusal of an Admin-area tool for a scope without that area. */
export function adminAreaError(area: string): string {
  return `This tool manages the brain's ${area}: it runs only for a user of the Admin workspace whose ${area} area is on.`;
}

/** The refusal of an Admin-only kind's create outside Admin. */
export const ADMIN_KIND_CREATE_ERROR =
  'This kind of item (a contact, a journal entry, a saved place) lives in the Admin workspace only, and you are not a user of it. Make a note or a page instead.';

/** The refusal of a call nothing declared a policy for (plan rule 3). */
export const NO_POLICY_ERROR = 'This is not open: nothing declares who may call it.';

const BRAND = Symbol.for('mantle.access-error');

/**
 * A refusal of the gate (plan section 2). Thrown by a step, read by the
 * mapper. `message` is what a tool says; the HTTP body is the mapper's.
 */
export class AccessError extends Error {
  readonly kind: AccessKind;
  /** The Admin area of an `area` refusal. */
  readonly area: string | null;
  readonly [BRAND] = true;

  constructor(kind: AccessKind, message?: string, opts: { area?: string } = {}) {
    super(message ?? defaultMessage(kind, opts.area ?? null));
    this.name = 'AccessError';
    this.kind = kind;
    this.area = opts.area ?? null;
  }
}

function defaultMessage(kind: AccessKind, area: string | null): string {
  switch (kind) {
    case 'unauthorized':
      return 'unauthorized';
    case 'unclassified':
      return NO_POLICY_ERROR;
    case 'narrowed':
      return 'This connection may not call this.';
    case 'admin':
      return ADMIN_ONLY_ERROR;
    case 'admin-kind':
      return ADMIN_KIND_CREATE_ERROR;
    case 'area':
      return adminAreaError(area ?? 'settings');
    case 'workspace':
      return 'You are not in that workspace.';
    case 'invalid':
      return 'ws must be a workspace id.';
  }
}

/** Whether `err` is an AccessError, also one a second copy of this module
 *  made (a bundler split): known by its brand, never by instanceof alone. */
export function isAccessError(err: unknown): err is AccessError {
  return !!err && typeof err === 'object' && (err as { [BRAND]?: unknown })[BRAND] === true;
}

// ── The database's refusals ─────────────────────────────────────────────────

/** What a caller outside the server may read of a database error. */
export const DATABASE_ERROR_PUBLIC =
  'the database could not run this request (the details are in the server log)';

/** What a person sees when a folder move or delete is refused because the
 *  folder holds items they cannot read (arch A3a, migration 0282). */
export const HIDDEN_ROWS_PUBLIC = 'This folder holds items you cannot move.';

/** A Postgres error's fields that callers read. */
export type DatabaseErrorFields = {
  code: string;
  detail?: unknown;
  message?: unknown;
  constraint_name?: unknown;
  cause?: unknown;
};

/**
 * THE walk to the database error on a thrown value: the error itself or one
 * of up to three causes below it (drizzle wraps the driver's), the first
 * that carries a five-character SQLSTATE. Every reader of a code or a
 * detail uses it (@mantle/db's pg-error.ts too).
 */
export function findDatabaseError(err: unknown): DatabaseErrorFields | null {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return e as DatabaseErrorFields;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The messages of the database's own write refusals (isScopeWriteRefusal). */
const SCOPE_WRITE_REFUSALS = new RegExp(
  '^(' +
    [
      'not allowed to (move this item|add items to that folder|delete this item|change this item' +
        '|share this item|edit this item|create an item in that workspace|grant to that workspace' +
        "|change the kind of this item|change anything|change this app's|write this app's)",
      'This folder holds items you cannot move',
      'placing this app adds a workspace you do not moderate',
      'this kind of item lives in the Admin workspace only',
      'no workspace to create this item in',
      'new row violates row-level security policy',
    ].join('|') +
    ')',
);

/**
 * A write the workspace checks refused (42501 with one of their own
 * messages): an Admin user's move, create in a folder or delete of an item
 * its workspaces may not change (0241, 0245, 0266, W6a fix round 1); a
 * change to, or a share of, a read-only snapshot copy (0267, W6b fix round
 * 1); the create home's refusals (mantle_default_home, 0267); the write
 * role's own checks (0278, 0279: edit, create, grant, a kind change, an
 * app's placement) and its row rule ("new row violates row-level security
 * policy", a row moved out of what the scope reads; arch A2b2b); the edit
 * check's (arch A3a, 0280 and 0281), which also carry a detail the mapper
 * reads (editRefusalDetail). Matched by message too, so a missing grant
 * (also 42501, isPermissionGap) stays a 500.
 */
export function isScopeWriteRefusal(err: unknown): boolean {
  const pg = findDatabaseError(err);
  if (!pg || pg.code !== '42501') return false;
  const message = typeof pg.message === 'string' ? pg.message : '';
  return SCOPE_WRITE_REFUSALS.test(message);
}

/** The details of the edit check's refusals (plan 5.2): the caller may not
 *  read the item, may read but not change it, the item is read only
 *  (Informational), or the caller only reads (a read key, a link, an
 *  assistant with no user). */
export type EditRefusalDetail = 'no_read' | 'no_edit' | 'read_only' | 'ro_actor';

const EDIT_REFUSAL_DETAILS: ReadonlySet<string> = new Set([
  'no_read',
  'no_edit',
  'read_only',
  'ro_actor',
]);

/** The detail of an edit check refusal (42501 with one of the details
 *  above, mantle_edit_refuse), else null. */
export function editRefusalDetail(err: unknown): EditRefusalDetail | null {
  const pg = findDatabaseError(err);
  if (!pg || pg.code !== '42501' || typeof pg.detail !== 'string') return null;
  return EDIT_REFUSAL_DETAILS.has(pg.detail) ? (pg.detail as EditRefusalDetail) : null;
}

/** A folder move or delete refused because the folder holds rows the
 *  caller cannot read (mantle_subtree_refuse_hidden, 0282): a 409. */
export function isHiddenRowsRefusal(err: unknown): boolean {
  const pg = findDatabaseError(err);
  return !!pg && pg.code === '42501' && pg.detail === 'hidden_rows';
}

/** A viewer level conflict (@mantle/db viewer.ts, ViewerLevelConflictError):
 *  known by its code, never by instanceof (a second copy of the db module
 *  must not turn the refusal into a 500). */
export function isLevelConflict(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: unknown }).code === 'viewer-level-conflict'
  );
}

// ── The one mapper ──────────────────────────────────────────────────────────

/** An HTTP answer: the status and the JSON body. */
export type AccessHttp = { status: number; body: Record<string, unknown> };

/** What a refusal is on every surface. */
export type AccessRefusal = {
  /** The gate's kind, or what the database or the scope refused. */
  kind: AccessKind | 'database' | 'level-conflict';
  /** The stable code (plan 10). */
  code: string;
  /** The HTTP answer, as today. Null: the HTTP layer does not answer it as
   *  a refusal (its own error path: a 500, as today). */
  http: AccessHttp | null;
  /** What a tool says, as today. */
  toolText: string;
};

/** The words of the level conflict's 403. */
export const LEVEL_CONFLICT_MESSAGE = 'This is not available at your access level.';

/** The HTTP body of a gate refusal: the bodies the routes send today. */
function gateHttp(err: AccessError): AccessHttp {
  switch (err.kind) {
    case 'unauthorized':
      return { status: 401, body: { error: 'unauthorized' } };
    case 'unclassified':
      return {
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'unclassified-route',
          message: 'This route is not open.',
        },
      };
    case 'area':
      return {
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'area',
          ...(err.area ? { area: err.area } : {}),
          message: 'You cannot manage this part of the brain.',
        },
      };
    case 'admin':
    case 'admin-kind':
    case 'narrowed':
      return { status: 403, body: { error: 'forbidden', reason: err.kind, message: err.message } };
    case 'workspace':
      return {
        status: 403,
        body: { error: 'forbidden', reason: 'workspace', message: err.message },
      };
    case 'invalid':
      return { status: 400, body: { error: 'invalid', message: err.message } };
  }
}

const GATE_CODES: Record<AccessKind, string> = {
  unauthorized: 'unauthorized',
  unclassified: 'unclassified',
  narrowed: 'forbidden',
  admin: 'area',
  'admin-kind': 'area',
  area: 'area',
  workspace: 'forbidden',
  invalid: 'invalid',
};

/** The database's refusal, read (see mapAccessError). */
function databaseRefusal(err: unknown): AccessRefusal | null {
  const pg = findDatabaseError(err);
  if (!pg || pg.code !== '42501') return null;
  const scoped = isScopeWriteRefusal(err);
  // A folder move or delete that would leave rows the caller cannot read
  // behind (0282): a conflict, in plain words, naming nothing hidden.
  if (pg.detail === 'hidden_rows') {
    return {
      kind: 'database',
      code: 'hidden_items',
      http: scoped
        ? {
            status: 409,
            body: { error: HIDDEN_ROWS_PUBLIC, reason: 'hidden-items', code: 'hidden_items' },
          }
        : null,
      toolText: HIDDEN_ROWS_PUBLIC,
    };
  }
  const detail = editRefusalDetail(err);
  // The caller does not read the item: 404, as any item it may not read
  // (owner decision D2). A tool says "not found".
  if (detail === 'no_read') {
    return {
      kind: 'database',
      code: 'not_found',
      http: scoped
        ? {
            status: 404,
            body: {
              error: 'not found',
              reason: 'not-found',
              code: 'not_found',
              message: 'Not found.',
            },
          }
        : null,
      toolText: 'not found',
    };
  }
  if (!scoped) return null;
  // An Informational app's data, or a caller that only reads: 403,
  // reason read-only.
  if (detail === 'read_only' || detail === 'ro_actor') {
    return {
      kind: 'database',
      code: detail,
      http: {
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'read-only',
          code: detail,
          message:
            detail === 'read_only'
              ? 'This app is Informational: its data is read only.'
              : 'This caller only reads: it cannot change anything.',
        },
      },
      toolText: DATABASE_ERROR_PUBLIC,
    };
  }
  // no_edit, or no detail (the workspace checks before A3a): 403, reason
  // item-workspace, as before (jackdaw's "Add yourself" keys on it).
  return {
    kind: 'database',
    code: 'forbidden',
    http: {
      status: 403,
      body: {
        error: 'forbidden',
        reason: 'item-workspace',
        code: 'forbidden',
        message: 'You cannot change this item in your workspaces.',
      },
    },
    toolText: DATABASE_ERROR_PUBLIC,
  };
}

/**
 * THE one mapper (plan 10): what `err` is on every surface, or null when it
 * is no refusal (a bug, a missing grant, a busy database: each surface's own
 * error path). Reads, in order:
 *
 *  - a refusal of the gate (AccessError), up to three causes deep;
 *  - a viewer level conflict (a client scope meeting public-level work);
 *  - the database's: a folder that holds items the caller cannot move
 *    (409), an item the caller does not read (404; a tool says "not
 *    found"), an Informational app's data or a read-only caller (403
 *    read-only), and any other workspace check (403 item-workspace). The
 *    HTTP answer needs the workspace check's own message (a 42501 that is a
 *    missing grant stays a 500); the tool text reads the detail alone, and
 *    says the generic DATABASE_ERROR_PUBLIC for what it does not name.
 */
export function mapAccessError(err: unknown): AccessRefusal | null {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    if (isAccessError(e)) {
      return { kind: e.kind, code: GATE_CODES[e.kind], http: gateHttp(e), toolText: e.message };
    }
    e = (e as { cause?: unknown }).cause;
  }
  if (isLevelConflict(err)) {
    return {
      kind: 'level-conflict',
      code: 'level_conflict',
      http: {
        status: 403,
        body: { error: 'forbidden', reason: 'level-conflict', message: LEVEL_CONFLICT_MESSAGE },
      },
      toolText: (err as Error).message,
    };
  }
  return databaseRefusal(err);
}
