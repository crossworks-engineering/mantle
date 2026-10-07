/**
 * App identity (2026-10-02; docs/app-authoring-guide.md, "Who is running the
 * app"). Two things a running mini app gets about the person running it:
 *
 *  - `host.me()`: `{ id, name, kind }` for display, baked into the frame
 *    document by the frame route (resolveAppViewer below).
 *  - Server-filled SQL parameters: an app writes `:host_me_id`,
 *    `:host_me_name` or `:host_me_kind` in its host.db SQL and the BROKER
 *    binds them from the authenticated caller (bindViewerParams below).
 *    Anything the browser sends under a reserved name is refused, so "who"
 *    in app data cannot be faked by a hand-made request.
 *
 * No email, by design: an app is code the admin may not have written.
 *
 * The id is a per-app pseudonym: HMAC-SHA256 of `login:<id>` or
 * `contact:<id>`, keyed with the app's random `app_databases.viewer_salt`
 * (migration 0217). Stable for one person inside one app, different in every
 * other app, and the app cannot reverse it. A login keeps its id when its
 * role changes (admin, member and client all hash `login:`).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { appDatabases, authUsers, db, nodes } from '@mantle/db';
import { stripLiterals } from '@mantle/tabledb';
import {
  APP_VIEWER_PARAMS,
  APP_VIEWER_PARAM_PREFIX,
  PUBLIC_APP_VIEWER,
  type AppViewer,
} from '@mantle/client-types/app-viewer';
import { AppSqlError } from './app-sql-runner';

export type { AppViewer, AppViewerKind } from '@mantle/client-types/app-viewer';
export { PUBLIC_APP_VIEWER } from '@mantle/client-types/app-viewer';

/**
 * Who the caller is, as the route knows it. A broker hands this to
 * appDbQuery / appDbExec; the pseudonym and any missing name are resolved
 * only when the SQL uses a reserved parameter, so an app that never does
 * costs no extra read.
 *
 * `name` undefined means "look it up" (the frame routes hold only the login
 * or contact id); null means "this person has no display name".
 */
export type AppViewerSubject =
  | { kind: 'admin' | 'member' | 'client'; loginId: string; name?: string | null }
  | { kind: 'contact'; contactId: string; name?: string | null }
  | { kind: 'public' };

/** The id prefix: a pseudonym, never a raw login or contact id. */
const ID_PREFIX = 'u_';

/** The pseudonym for one subject under one app's salt (pure; exported for
 *  tests). 128 bits of the HMAC, base64url: 22 characters after the prefix. */
export function appViewerPseudonym(salt: string, subject: string): string {
  const mac = createHmac('sha256', salt).update(subject).digest();
  return ID_PREFIX + mac.subarray(0, 16).toString('base64url');
}

/** Salts by app node id. A salt never changes once set, so the cache needs
 *  no expiry; a deleted app's entry is harmless (its node id never returns). */
const saltCache = new Map<string, string>();

/**
 * The app's viewer salt, created on first use. Needs the app's registry row
 * (ensureRegistry in app-broker.ts creates it); the frame route reaches this
 * through appViewerSaltFor, which provisions the row first.
 */
export async function appViewerSalt(registryId: string, appNodeId: string): Promise<string> {
  const cached = saltCache.get(appNodeId);
  if (cached) return cached;
  // One statement: two first users at once both get the salt that won.
  const [row] = await db
    .update(appDatabases)
    .set({
      viewerSalt: sql`coalesce(${appDatabases.viewerSalt}, ${randomBytes(32).toString('base64url')})`,
    })
    .where(eq(appDatabases.id, registryId))
    .returning({ salt: appDatabases.viewerSalt });
  if (!row?.salt) throw new Error('could not provision the app viewer salt');
  saltCache.set(appNodeId, row.salt);
  return row.salt;
}

/** Test seam: forget cached salts. */
export function __resetAppViewerSaltCache(): void {
  saltCache.clear();
}

async function loginDisplayName(loginId: string): Promise<string | null> {
  const [row] = await db
    .select({ displayName: authUsers.displayName })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return cleanName(row?.displayName);
}

async function contactName(ownerId: string, contactId: string): Promise<string | null> {
  const [row] = await db
    .select({ title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, contactId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  return cleanName(row?.title);
}

/** A display name, or null. Never derived from an email. */
function cleanName(name: string | null | undefined): string | null {
  const t = name?.trim();
  return t ? t.slice(0, 200) : null;
}

/**
 * Resolve a subject to the AppViewer an app sees. `salt` is a thunk so the
 * caller provisions the registry only when an id is needed.
 */
export async function resolveAppViewer(
  ownerId: string,
  subject: AppViewerSubject,
  salt: () => Promise<string>,
): Promise<AppViewer> {
  if (subject.kind === 'public') return PUBLIC_APP_VIEWER;
  if (subject.kind === 'contact') {
    const name =
      subject.name !== undefined
        ? cleanName(subject.name)
        : await contactName(ownerId, subject.contactId);
    return {
      id: appViewerPseudonym(await salt(), `contact:${subject.contactId}`),
      name,
      kind: 'contact',
    };
  }
  const name =
    subject.name !== undefined ? cleanName(subject.name) : await loginDisplayName(subject.loginId);
  return {
    id: appViewerPseudonym(await salt(), `login:${subject.loginId}`),
    name,
    kind: subject.kind,
  };
}

// ── Server-filled SQL parameters ────────────────────────────────────────────

/** A named-parameter reference with the reserved prefix: `:`, `@` or `$`,
 *  then the prefix in any case, then the rest of the name. */
const RESERVED_REF = new RegExp(`[:@$](${APP_VIEWER_PARAM_PREFIX}[A-Za-z0-9_]*)`, 'gi');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isReservedKey(key: string): boolean {
  return key
    .replace(/^[:@$]/, '')
    .toLowerCase()
    .startsWith(APP_VIEWER_PARAM_PREFIX);
}

/**
 * Which reserved parameters the SQL uses, as written (prefix character
 * included, e.g. `:host_me_id`). Refuses a name with the reserved prefix that
 * is not one of the three, in any case (`:host_me_email`, `:HOST_ME_ID`):
 * SQLite names are case-sensitive, so a near miss would silently bind NULL.
 * String literals and comments are not parameters and are skipped.
 */
export function viewerParamRefs(sqlText: string): string[] {
  const found = new Set<string>();
  for (const m of stripLiterals(sqlText).matchAll(RESERVED_REF)) {
    const bare = m[1]!;
    if (!Object.hasOwn(APP_VIEWER_PARAMS, bare)) {
      throw new AppSqlError(
        `unknown reserved parameter ${m[0]}: names starting with ${APP_VIEWER_PARAM_PREFIX} belong to the host, which fills only :host_me_id, :host_me_name and :host_me_kind (lower case)`,
      );
    }
    found.add(m[0]);
  }
  return [...found];
}

/**
 * Bind the server-filled parameters into a broker statement's params.
 *
 * `params` is what the browser sent: positional values, optionally led by a
 * plain object of named values (Node's SQLite binds a leading object by
 * name and the rest by position, and never lets a positional value reach a
 * named slot). So:
 *  - a reserved key in that object is refused: only the server fills them;
 *  - SQL that uses no reserved name gets its params back untouched;
 *  - otherwise the reserved values are merged into the leading object (or a
 *    new leading object), keyed exactly as written in the SQL.
 *
 * `viewer` is a thunk, resolved only when the SQL uses a reserved name.
 * Without one (a caller that names no person, such as the assistant's
 * app_db_query) SQL that uses a reserved name is refused, never bound to
 * NULL and never to anything the caller sent: the check fails closed.
 */
export async function bindViewerParams(
  sqlText: string,
  params: unknown[],
  viewer: (() => Promise<AppViewer>) | null,
): Promise<unknown[]> {
  const lead = params.length > 0 && isPlainObject(params[0]) ? params[0] : null;
  if (lead && Object.keys(lead).some(isReservedKey)) {
    throw new AppSqlError(
      `parameters starting with ${APP_VIEWER_PARAM_PREFIX} are filled by the host from the signed-in person; do not send them`,
    );
  }
  const refs = viewerParamRefs(sqlText);
  if (refs.length === 0) return params;
  if (!viewer) {
    throw new AppSqlError(
      ':host_me_* parameters are filled only when a person runs the app (not from this caller)',
    );
  }
  const me = await viewer();
  const fill: Record<string, unknown> = {};
  for (const ref of refs) {
    const field = APP_VIEWER_PARAMS[ref.slice(1) as keyof typeof APP_VIEWER_PARAMS];
    fill[ref] = me[field];
  }
  return lead ? [{ ...lead, ...fill }, ...params.slice(1)] : [fill, ...params];
}
