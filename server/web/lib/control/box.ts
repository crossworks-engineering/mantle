/**
 * The subject box's side of the Control Center (docs/control-center.md,
 * plan sections 2.3, 3.1, 3.5, 3.6): POST /api/control/call.
 *
 * Two checks and no third:
 *  1. The signature (handleControlCall): the box is a subject, the body is
 *     at most 64 KB, the time is within 60 seconds, and the CC's key signed
 *     this box's own origin over the raw bytes. Only then is the JSON read.
 *  2. A fixed switch of five cases: hello, logins, disable, enable,
 *     archive. They are not tools: no agent, MCP client or API key on the
 *     box reaches them.
 *
 * disable, enable and archive run the users area's own change
 * (applyLoginChange) as the control-center actor, so every way in ends at
 * once and the original account is never touched. disable writes a
 * marker (control_disables: the disabled_at it set); enable acts only
 * while that marker still equals the login's disabled_at; archive stamps a
 * new disabled_at, sets archived_at and drops the marker, so neither the CC
 * nor SCIM can enable it again. Nothing is ever deleted.
 */
import { z } from 'zod';
import {
  authUsers,
  controlDisables,
  db,
  eq,
  inArray,
  isNotNull,
  oidcSigninLinks,
  onFullSystemRoute,
  sql,
} from '@mantle/db';
import type { ControlLogin } from '@mantle/db';
import { NextResponse } from '@/server/http-compat';
import type { SessionUser } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readBytesCapped, CONTROL_BODY_CEILING_BYTES, BodyTooLargeError } from '@/lib/body-limit';
import { applyLoginChange, loadLoginTarget, type LoginTx } from '@/lib/login-update';
import { brainOwnerId } from '@/lib/scim/store';
import { subjectConfig } from './env';
import { CONTROL_PATH, CONTROL_SIG_HEADER, CONTROL_TIME_HEADER, verifyCall } from './sign';

/** The actor's word on every control audit row. */
export const CONTROL_ACTOR = 'control-center';

/** The most login ids one call names. */
export const CONTROL_MAX_IDS = 1000;

const Ids = z.object({ loginIds: z.array(z.string().uuid()).max(CONTROL_MAX_IDS) }).strict();
const Call = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hello'), args: z.object({}).strict().optional() }).strict(),
  z.object({ op: z.literal('logins'), args: z.object({}).strict().optional() }).strict(),
  z.object({ op: z.literal('disable'), args: Ids }).strict(),
  z.object({ op: z.literal('enable'), args: Ids }).strict(),
  z.object({ op: z.literal('archive'), args: Ids }).strict(),
]);
type Op = z.infer<typeof Call>['op'];

const refuse = (reason: string, status: number) =>
  NextResponse.json({ error: 'refused', reason }, { status });

/** The route: check 1, then the switch. */
export async function handleControlCall(req: Request): Promise<Response> {
  const cfg = subjectConfig();
  // Not a subject: the route does not exist.
  if (!cfg.on) return NextResponse.json({ error: 'not found' }, { status: 404 });
  let raw: Buffer;
  try {
    raw = await readBytesCapped(req, CONTROL_BODY_CEILING_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return refuse('size', 413);
    throw err;
  }
  const why = verifyCall(
    cfg.key,
    cfg.origin,
    raw,
    req.headers.get(CONTROL_TIME_HEADER),
    req.headers.get(CONTROL_SIG_HEADER),
  );
  if (why) return refuse(why, 401);
  let parsed: z.infer<typeof Call>;
  try {
    const r = Call.safeParse(JSON.parse(raw.toString('utf8')));
    if (!r.success) return refuse('bad-call', 400);
    parsed = r.data;
  } catch {
    return refuse('bad-call', 400);
  }
  const actor = await controlCaller();
  if (!actor) return refuse('not-set-up', 503);
  const answer = await runOp(actor, parsed);
  if (parsed.op === 'disable' || parsed.op === 'enable' || parsed.op === 'archive') {
    audit(req, parsed.op, answer);
  }
  return NextResponse.json(answer);
}

async function runOp(actor: SessionUser, call: z.infer<typeof Call>) {
  switch (call.op) {
    case 'hello':
      return { ok: true, path: CONTROL_PATH };
    case 'logins':
      return { logins: await listLogins() };
    case 'disable':
      return disableLogins(actor, unique(call.args.loginIds));
    case 'enable':
      return enableLogins(actor, unique(call.args.loginIds));
    case 'archive':
      return archiveLogins(actor, unique(call.args.loginIds));
  }
}

const unique = (ids: string[]) => [...new Set(ids.map((id) => id.toLowerCase()))];

/** The control-center actor handed to the users area's change, as SCIM's:
 *  the brain (its anchor) owns what the change touches. Null on a box with
 *  no original account yet. */
async function controlCaller(): Promise<SessionUser | null> {
  const anchor = await brainOwnerId();
  if (!anchor) return null;
  return {
    id: anchor,
    email: CONTROL_ACTOR,
    actor: { id: anchor, email: CONTROL_ACTOR, displayName: 'Control Center', isOwner: false },
  };
}

function audit(req: Request, op: Op, answer: unknown) {
  auditFireAndForget({
    actorId: null,
    actorEmail: CONTROL_ACTOR,
    action: 'user.update',
    method: req.method,
    path: CONTROL_PATH,
    detail: { via: 'control', op, result: answer },
    ...requestMetaFrom(req),
  });
}

// --- logins ------------------------------------------------------------------

/** Every login: id, email (lowercase), flags, and its company sign-in ids.
 *  No names, no other data. */
export async function listLogins(): Promise<ControlLogin[]> {
  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      owner: authUsers.isOwner,
      disabledAt: authUsers.disabledAt,
      archivedAt: authUsers.archivedAt,
      marked: sql<boolean>`coalesce(${controlDisables.disabledAt} = ${authUsers.disabledAt}, false)`,
    })
    .from(authUsers)
    .leftJoin(controlDisables, eq(controlDisables.loginId, authUsers.id));
  const links = await db
    .select({
      loginId: oidcSigninLinks.loginId,
      issuer: oidcSigninLinks.issuer,
      oid: oidcSigninLinks.oid,
    })
    .from(oidcSigninLinks)
    .where(isNotNull(oidcSigninLinks.oid));
  const byLogin = new Map<string, { issuer: string; oid: string }[]>();
  for (const l of links) {
    const list = byLogin.get(l.loginId) ?? [];
    list.push({ issuer: l.issuer, oid: l.oid! });
    byLogin.set(l.loginId, list);
  }
  return rows.map((r) => ({
    id: r.id,
    email: r.email.toLowerCase(),
    owner: r.owner,
    disabled: r.disabledAt !== null,
    archived: r.archivedAt !== null,
    marked: r.marked === true,
    links: byLogin.get(r.id) ?? [],
  }));
}

// --- disable -----------------------------------------------------------------

/** Thrown inside a change whose login changed since the read. */
class Raced extends Error {}

/** Runs `change`, and answers 'raced' when its firstInTx threw Raced. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | 'raced'> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Raced) return 'raced';
    throw err;
  }
}

async function lockedRow(tx: LoginTx, loginId: string) {
  const rows = (await tx.execute(sql`select u.disabled_at, u.archived_at, d.disabled_at as marker
    from auth.users u left join public.control_disables d on d.login_id = u.id
    where u.id = ${loginId} for update of u`)) as unknown as {
    disabled_at: Date | string | null;
    archived_at: Date | string | null;
    marker: Date | string | null;
  }[];
  return rows[0] ?? null;
}

const sameTime = (a: Date | string | null, b: Date | string | null) =>
  a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime();

export async function disableLogins(actor: SessionUser, ids: string[]) {
  const out = { disabled: 0, already: 0, notFound: 0, owner: [] as string[] };
  for (const id of ids) {
    const target = await loadLoginTarget(id);
    if (!target) {
      out.notFound++;
      continue;
    }
    if (target.isOwner) {
      out.owner.push(id);
      continue;
    }
    const at = new Date();
    // The disable and its marker in one transaction, at the full-route
    // spot login-credential (the narrow login holds no write of the
    // marker), checked again under the row's lock: a disable made since
    // the read stays its maker's.
    const r = await onFullSystemRoute('login-credential', () =>
      guarded(() =>
        applyLoginChange(
          actor,
          target,
          { disabled: true, disabledAt: at },
          async (tx) => {
            await tx
              .insert(controlDisables)
              .values({ loginId: id, disabledAt: at })
              .onConflictDoUpdate({ target: controlDisables.loginId, set: { disabledAt: at } });
          },
          async (tx) => {
            const row = await lockedRow(tx, id);
            if (!row || row.disabled_at !== null) throw new Raced();
          },
        ),
      ),
    );
    if (r === 'raced') {
      out.already++;
      continue;
    }
    if (!r.ok) {
      if (r.reason === 'owner') out.owner.push(id);
      else out.already++;
      continue;
    }
    out.disabled++;
  }
  return out;
}

// --- enable ------------------------------------------------------------------

export async function enableLogins(actor: SessionUser, ids: string[]) {
  const out = { enabled: 0, notMarked: 0, notFound: 0 };
  for (const id of ids) {
    const target = await loadLoginTarget(id);
    if (!target) {
      out.notFound++;
      continue;
    }
    // The one check, under the row's lock: the CC's marker still equals the
    // login's disabled_at (an archived login has no marker).
    // At login-credential, as every enable is (lib/login-update.ts): the
    // marker's drop commits with it.
    const r = await onFullSystemRoute('login-credential', () =>
      guarded(() =>
        applyLoginChange(
          actor,
          target,
          { disabled: false },
          async (tx) => {
            await tx.delete(controlDisables).where(eq(controlDisables.loginId, id));
          },
          async (tx) => {
            const row = await lockedRow(tx, id);
            if (!row || row.archived_at !== null || !sameTime(row.marker, row.disabled_at)) {
              throw new Raced();
            }
          },
        ),
      ),
    );
    if (r === 'raced' || !r.ok) out.notMarked++;
    else out.enabled++;
  }
  return out;
}

// --- archive -----------------------------------------------------------------

export async function archiveLogins(actor: SessionUser, ids: string[]) {
  const out = { archived: 0, already: 0, notFound: 0, owner: [] as string[] };
  const known = ids.length
    ? await db
        .select({ id: authUsers.id, archivedAt: authUsers.archivedAt })
        .from(authUsers)
        .where(inArray(authUsers.id, ids))
    : [];
  const archived = new Set(known.filter((k) => k.archivedAt !== null).map((k) => k.id));
  for (const id of ids) {
    if (archived.has(id)) {
      out.already++;
      continue;
    }
    const target = await loadLoginTarget(id);
    if (!target) {
      out.notFound++;
      continue;
    }
    if (target.isOwner) {
      out.owner.push(id);
      continue;
    }
    // A new disabled_at, always: a disable SCIM or the CC made before has
    // its own marker, which then no longer matches, so neither can enable
    // the archived login. Every way in ends again (idempotent).
    const at = new Date();
    // One transaction: the disable, archived_at, and the marker dropped.
    const r = await onFullSystemRoute('login-credential', () =>
      guarded(() =>
        applyLoginChange(
          actor,
          target,
          { disabled: true, disabledAt: at },
          async (tx) => {
            await tx.update(authUsers).set({ archivedAt: at }).where(eq(authUsers.id, id));
            await tx.delete(controlDisables).where(eq(controlDisables.loginId, id));
          },
          async (tx) => {
            const row = await lockedRow(tx, id);
            if (!row || row.archived_at !== null) throw new Raced();
          },
        ),
      ),
    );
    if (r === 'raced') {
      out.already++;
      continue;
    }
    if (!r.ok) {
      if (r.reason === 'owner') out.owner.push(id);
      else out.already++;
      continue;
    }
    out.archived++;
  }
  return out;
}
