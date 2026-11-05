/**
 * SCIM 2.0 user provisioning (docs/scim.md; corporate plan Phase 5): what
 * the /scim/v2 routes do. A company's identity provider (Entra ID, Okta,
 * any SCIM client) creates logins, renames them, and disables the ones it
 * blocks, so a leaver loses Mantle access the same day.
 *
 *  - Off unless the box .env names the token's hash (settings.ts): every
 *    route answers 404 and nothing reads the database.
 *  - A disable (PATCH or PUT `active: false`, or DELETE) is the users
 *    area's own disable (login-update.ts applyLoginChange): every session,
 *    device bearer, API key, MCP grant, peer and pairing code of the login
 *    ends, its push devices go, and its personal assistant is released.
 *    DELETE removes nothing: the login and all it made stay.
 *  - A disable comes first in a request: an attribute the brain cannot read,
 *    or an externalId it refuses, is answered after it (applyChange).
 *  - An enable (`active: true`) undoes only the provider's own disable, and
 *    never for an Admin user: a login an admin disabled stays disabled.
 *  - A create makes a member login with no password and no workspace. It
 *    reaches nothing until an admin adds it. SCIM never makes an admin, and
 *    answers 503 on a box with no original account yet.
 *  - The provider's externalId is set once; a userName finds a login only
 *    until the provider gave it one (store.ts scimLoginByUserName).
 *  - The original account is never seen nor changed: it is the emergency
 *    admin, outside the provider's reach.
 *  - The email a login was made with is kept: a userName the provider
 *    renames is accepted and left as it was (the Users screen cannot change
 *    an email either), so a rename never blocks the disable in the same
 *    change.
 *  - Every change writes the users area's own audit row (user.create,
 *    user.update) with `scim` as the actor and `via: 'scim'`.
 */
import { randomUUID } from 'node:crypto';
import { env } from '@mantle/config';
import { isUniqueViolation } from '@mantle/db';
import { isFormerClientEmail } from '@mantle/content';
import { isUuid } from '@mantle/std';
import { NextResponse } from '@/server/http-compat';
import type { SessionUser } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { applyLoginChange, loadLoginTarget, type LoginChange } from '@/lib/login-update';
import { readJson } from '@/lib/read-body';
import { scimTokenHash, scimTokenMatches } from './settings';
import {
  listBody,
  parseFilter,
  parsePage,
  parsePatch,
  parseUserBody,
  SCIM_CONTENT_TYPE,
  scimErrorBody,
  toScimUser,
  type Problem,
  type ScimChange,
  type ScimLogin,
} from './shapes';
import {
  brainOwnerId,
  createScimLogin,
  emailTaken,
  writeScimRow,
  scimLoginByExternalId,
  scimLoginById,
  scimLoginByUserName,
  scimEnableFacts,
  scimLoginPage,
} from './store';

/** The actor's word on every SCIM audit row. */
export const SCIM_ACTOR = 'scim';

/** A SCIM answer: JSON with SCIM's own content type. */
export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { 'content-type': SCIM_CONTENT_TYPE, ...headers },
  });
}

export function scimError(status: number, detail: string, scimType?: string) {
  return scimJson(scimErrorBody(status, detail, scimType), status);
}

function bearer(req: Request): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '');
  return m?.[1] ?? '';
}

/**
 * Null when the request may go on, else the answer to send: SCIM off is
 * a plain 404 (the same for every path, with no SCIM shape: nothing says
 * the route exists); a missing or wrong token a SCIM 401.
 */
export function scimGate(req: Request): Response | null {
  const hash = scimTokenHash();
  if (!hash) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!scimTokenMatches(bearer(req), hash)) {
    const res = scimError(401, 'A valid bearer token is required.');
    res.headers.set('www-authenticate', 'Bearer');
    return res;
  }
  return null;
}

/** The box's /scim/v2 URL for meta.location, or '' (relative) with no
 *  public URL set. */
export function scimBase(): string {
  const url = (env('MANTLE_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
  return `${url}/scim/v2`;
}

const userBody = (l: ScimLogin) => toScimUser(l, scimBase());

/**
 * The SCIM actor handed to the users area's change, on a box that is set
 * up: the brain (its anchor) owns what the change touches. Null on a box
 * with no original account yet, where every Users route answers 503: a
 * provider's first sync must never make the first login, which first-run
 * sign-up would then take for the owner.
 */
async function scimCaller(): Promise<SessionUser | null> {
  const anchor = await brainOwnerId();
  if (!anchor) return null;
  return {
    id: anchor,
    email: SCIM_ACTOR,
    actor: { id: anchor, email: SCIM_ACTOR, displayName: 'SCIM', isOwner: false },
  };
}

const notSetUp = () => scimError(503, 'The box is not set up yet: make its first account first.');

function audit(
  req: Request,
  action: 'user.create' | 'user.update',
  detail: Record<string, unknown>,
) {
  const path = new URL(req.url).pathname;
  auditFireAndForget({
    actorId: null,
    actorEmail: SCIM_ACTOR,
    action,
    method: req.method,
    path,
    detail: { ...detail, via: 'scim' },
    ...requestMetaFrom(req),
  });
}

async function readBody(req: Request): Promise<unknown> {
  return readJson(req, { invalid: undefined, refuseEmpty: true });
}

// --- Reads -------------------------------------------------------------------

export async function listUsers(req: Request): Promise<Response> {
  if (!(await scimCaller())) return notSetUp();
  const q = new URL(req.url).searchParams;
  const filter = parseFilter(q.get('filter'));
  const { startIndex, count } = parsePage(q);
  if (filter === 'bad') {
    return scimError(
      400,
      'Only userName eq, externalId eq and id eq filters are supported.',
      'invalidFilter',
    );
  }
  if (filter) {
    const hit =
      filter.attr === 'userName'
        ? await scimLoginByUserName(filter.value)
        : filter.attr === 'externalId'
          ? await scimLoginByExternalId(filter.value)
          : isUuid(filter.value)
            ? await scimLoginById(filter.value.toLowerCase())
            : null;
    const found = hit ? [hit] : [];
    const page = startIndex === 1 && count > 0 ? found : [];
    return scimJson(listBody(page.map(userBody), found.length, startIndex));
  }
  const { logins, total } = await scimLoginPage(startIndex - 1, count);
  return scimJson(listBody(logins.map(userBody), total, startIndex));
}

/** The login a /Users/:id path names, or null (the caller's 404). */
async function loginAt(id: string): Promise<ScimLogin | null> {
  return isUuid(id) ? await scimLoginById(id.toLowerCase()) : null;
}

const notFound = () => scimError(404, 'User not found.');

export async function getUser(id: string): Promise<Response> {
  if (!(await scimCaller())) return notSetUp();
  const login = await loginAt(id);
  return login ? scimJson(userBody(login)) : notFound();
}

// --- Writes ------------------------------------------------------------------

export async function createUser(req: Request): Promise<Response> {
  if (!(await scimCaller())) return notSetUp();
  const parsed = parseUserBody(await readBody(req), 'create');
  if (!parsed.ok) return scimError(400, parsed.detail, parsed.scimType);
  // Nothing to protect yet: a create applies whole or not at all.
  if (parsed.problem) return scimError(400, parsed.problem.detail, parsed.problem.scimType);
  const want = parsed.value;
  const email = want.userName!;
  if (await emailTaken(email)) {
    return scimError(409, 'A login with that userName already exists.', 'uniqueness');
  }
  // A former client (archived by 0272) never comes back as a login by
  // itself, as on the Users screen.
  if (await isFormerClientEmail(email)) {
    return scimError(409, 'That userName belonged to a former client login.', 'uniqueness');
  }
  if (want.externalId && (await scimLoginByExternalId(want.externalId))) {
    return scimError(409, 'A login with that externalId already exists.', 'uniqueness');
  }
  const id = randomUUID();
  try {
    await createScimLogin({
      id,
      email,
      displayName: want.displayName ?? null,
      externalId: want.externalId ?? null,
      disabled: want.active === false,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return scimError(
        409,
        'A login with that userName or externalId already exists.',
        'uniqueness',
      );
    }
    throw err;
  }
  audit(req, 'user.create', {
    targetId: id,
    targetEmail: email,
    role: 'member',
    active: want.active !== false,
  });
  const login = await scimLoginById(id);
  if (!login) return scimError(500, 'The login was created but could not be read back.');
  const body = userBody(login);
  return scimJson(body, 201, { location: body.meta.location });
}

/**
 * Apply `want` to `login`, in this order, so nothing else in a request can
 * hold back a leaver's disable:
 *
 *  1. a disable (`active: false`), through the users area's own change
 *     (applyLoginChange), recorded as the provider's own disable, and
 *     audited at once;
 *  2. the request's problems: an attribute the parse could not read, an
 *     externalId held by another login, or a change of the externalId the
 *     provider set before (it names the person: it is set once). Each
 *     answers its error, after the disable;
 *  3. an enable, only of a login the provider itself disabled (its disable
 *     is still the one recorded), never an Admin user: a login an admin
 *     disabled stays disabled, and an Admin user is enabled by hand;
 *  4. a rename, then the externalId and the provider's row.
 *
 * A userName change is noted and left: a login keeps its email. Answers the
 * login as it now is.
 */
async function applyChange(
  req: Request,
  login: ScimLogin,
  want: ScimChange,
  problem: Problem | undefined,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const caller = await scimCaller();
  if (!caller) return notSetUp();
  const done: Record<string, unknown> = {};
  const notes: Record<string, unknown> = { ...extra };
  let sessionsEnded = false;
  const finish = (res: Response): Response => {
    if (Object.keys(done).length > 0 || Object.keys(notes).length > 0) {
      audit(req, 'user.update', {
        targetId: login.id,
        targetEmail: login.email,
        changes: done,
        ...(sessionsEnded ? { sessionsEnded: true } : {}),
        ...notes,
      });
    }
    return res;
  };
  const change = async (c: LoginChange): Promise<Response | null> => {
    const target = await loadLoginTarget(login.id);
    if (!target) return notFound();
    const r = await applyLoginChange(caller, target, c);
    if (!r.ok) return scimError(r.status, r.error);
    Object.assign(done, c);
    sessionsEnded ||= r.sessionsEnded;
    return null;
  };

  // 1. The disable first.
  if (want.active === false && !login.disabled) {
    const refusedDisable = await change({ disabled: true });
    if (refusedDisable) return finish(refusedDisable);
    await writeScimRow(login.id, { disable: 'mark' });
  }
  if (want.userName !== undefined && want.userName !== login.email.toLowerCase()) {
    notes.userNameKept = true;
  }

  // 2. What the request asked that cannot be done.
  if (problem) return finish(scimError(400, problem.detail, problem.scimType));
  const newExternal = want.externalId !== undefined && want.externalId !== login.externalId;
  if (newExternal && login.externalId !== null) {
    return finish(
      scimError(
        409,
        'externalId is set once and names the person: it cannot change.',
        'mutability',
      ),
    );
  }
  if (newExternal && want.externalId) {
    const other = await scimLoginByExternalId(want.externalId);
    if (other && other.id !== login.id) {
      return finish(scimError(409, 'Another login has that externalId.', 'uniqueness'));
    }
  }

  // 3. An enable, of the provider's own disable only, never an Admin user.
  if (want.active === true && login.disabled) {
    const facts = await scimEnableFacts(login.id);
    if (facts.admin) notes.enableKept = 'admin-user';
    else if (!facts.own) notes.enableKept = 'disabled-by-an-admin';
    else {
      const refusedEnable = await change({ disabled: false });
      if (refusedEnable) return finish(refusedEnable);
      await writeScimRow(login.id, { disable: 'clear' });
    }
  }

  // 4. The rename, then the externalId and the provider's row.
  if (want.displayName !== undefined && want.displayName !== login.displayName) {
    const refusedRename = await change({ displayName: want.displayName });
    if (refusedRename) return finish(refusedRename);
  }
  try {
    await writeScimRow(login.id, newExternal ? { externalId: want.externalId } : {});
  } catch (err) {
    if (isUniqueViolation(err)) {
      return finish(scimError(409, 'Another login has that externalId.', 'uniqueness'));
    }
    throw err;
  }
  if (newExternal) done.externalId = want.externalId;
  const now = await scimLoginById(login.id);
  return finish(now ? scimJson(userBody(now)) : notFound());
}

export async function patchUser(req: Request, id: string): Promise<Response> {
  if (!(await scimCaller())) return notSetUp();
  const login = await loginAt(id);
  if (!login) return notFound();
  const parsed = parsePatch(await readBody(req));
  if (!parsed.ok) return scimError(400, parsed.detail, parsed.scimType);
  return applyChange(req, login, parsed.value, parsed.problem);
}

export async function replaceUser(req: Request, id: string): Promise<Response> {
  if (!(await scimCaller())) return notSetUp();
  const login = await loginAt(id);
  if (!login) return notFound();
  const parsed = parseUserBody(await readBody(req), 'replace');
  if (!parsed.ok) return scimError(400, parsed.detail, parsed.scimType);
  return applyChange(req, login, parsed.value, parsed.problem);
}

/** DELETE: a disable. Nothing is removed: the login, its items, its links
 *  and its audit trail stay, and an admin may enable it again. */
export async function deleteUser(req: Request, id: string): Promise<Response> {
  if (!(await scimCaller())) return notSetUp();
  const login = await loginAt(id);
  if (!login) return notFound();
  const res = await applyChange(req, login, { active: false }, undefined, { deleted: true });
  return res.status === 200 ? new NextResponse(null, { status: 204 }) : res;
}
