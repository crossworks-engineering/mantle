/**
 * The subject box's side of the Control Center (docs/control-center.md,
 * plan sections 2.3, 3.1, 3.5, 3.6): POST /api/control/call.
 *
 * Two checks and no third:
 *  1. The signature (handleControlCall): the box is a subject, the body is
 *     at most 64 KB, the time is within 60 seconds, and the CC's key signed
 *     this box's own origin over the raw bytes. Only then is the JSON read.
 *  2. A fixed switch of twelve cases: hello, logins, facts, disable,
 *     enable, archive, key, agentModel, poolEntry, updateNotice,
 *     workerGroup, submissions. They are not tools: no agent, MCP client or
 *     API key on the box reaches them.
 *
 * disable, enable and archive run the users area's own change
 * (applyLoginChange) as the control-center actor, so every way in ends at
 * once and the original account is never touched. disable writes a
 * marker (control_disables: the disabled_at it set); enable acts only
 * while that marker still equals the login's disabled_at; archive stamps a
 * new disabled_at, sets archived_at and drops the marker, so neither the CC
 * nor SCIM can enable it again. Nothing is ever deleted.
 *
 * facts (phase 3, the fleet matrix, facts.ts) is a read: numbers,
 * settings and model ids only.
 *
 * submissions (plan 5559936a, submissions.ts) hands the CC the tasks
 * people sent to IT, one file at a time, takes their collected mark, and
 * puts the CC's reply on the person's task.
 *
 * agentModel (phase 4, agent-model.ts) sets the model of one agent the
 * system ships, the model field only, as the Agents screen does.
 * poolEntry, updateNotice and workerGroup (phase 4, fleet-writes.ts) run
 * the box's own path for a pool entry, the update notice, a worker group.
 *
 * key (phase 2, the fleet API-key update) sets one provider key, by the
 * service's name on this box's own fixed list (an AI provider, or a key
 * service the box knows), through the vault's own gateway as a key set on
 * the Keys screen: sealed, audited there, then tested. It answers ok or
 * not only: never the key, never the provider's text.
 */
import { z } from 'zod';
import {
  KNOWN_KEY_SERVICES,
  canProbeService,
  deleteVaultKey,
  getApiKeyById,
  defaultKeyRow,
  setVaultKey,
  testVaultKey,
  type VaultActor,
} from '@mantle/api-keys';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { getProvider } from '@mantle/voice';
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
import { CONTROL_MODEL_ID, type ControlLogin } from '@mantle/db/schema';
import { NextResponse } from '@/server/http-compat';
import type { SessionUser } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readBytesCapped, CONTROL_BODY_CEILING_BYTES, BodyTooLargeError } from '@/lib/body-limit';
import { applyLoginChange, loadLoginTarget, type LoginTx } from '@/lib/login-update';
import { loadAnchorId } from '@/lib/auth/login-row';
import { subjectConfig } from './env';
import { setAgentModel } from './agent-model';
import { runWrite, WRITE_CALLS } from './fleet-writes';
import { collectFacts } from './facts';
import {
  SUBMISSIONS_PER_LIST,
  fileForCenter,
  listForCenter,
  markCollected,
  replyFromCenter,
} from './submissions';
import { SUBMISSION_NOTE_MAX, SUBMISSION_VERSION_MAX } from '@mantle/client-types/task-submissions';
import { CONTROL_PATH, CONTROL_SIG_HEADER, CONTROL_TIME_HEADER, verifyCall } from './sign';

/** The actor's word on every control audit row. */
export const CONTROL_ACTOR = 'control-center';

/** The most login ids one call names. */
export const CONTROL_MAX_IDS = 1000;

/** The longest key value one call carries (the vault's own token cap). */
export const CONTROL_MAX_KEY = 8192;

const Ids = z.object({ loginIds: z.array(z.string().uuid()).max(CONTROL_MAX_IDS) }).strict();
const Call = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hello'), args: z.object({}).strict().optional() }).strict(),
  z.object({ op: z.literal('logins'), args: z.object({}).strict().optional() }).strict(),
  z.object({ op: z.literal('facts'), args: z.object({}).strict().optional() }).strict(),
  z.object({ op: z.literal('disable'), args: Ids }).strict(),
  z.object({ op: z.literal('enable'), args: Ids }).strict(),
  z.object({ op: z.literal('archive'), args: Ids }).strict(),
  z
    .object({
      op: z.literal('key'),
      args: z
        .object({
          service: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
          value: z.string().min(1).max(CONTROL_MAX_KEY),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal('submissions'),
      args: z.discriminatedUnion('do', [
        z.object({ do: z.literal('list') }).strict(),
        z
          .object({ do: z.literal('file'), taskId: z.string().uuid(), fileId: z.string().uuid() })
          .strict(),
        z
          .object({
            do: z.literal('collected'),
            taskIds: z.array(z.string().uuid()).max(SUBMISSIONS_PER_LIST),
          })
          .strict(),
        z
          .object({
            do: z.literal('reply'),
            taskId: z.string().uuid(),
            note: z.string().min(1).max(SUBMISSION_NOTE_MAX),
            version: z.string().max(SUBMISSION_VERSION_MAX),
            by: z.string().max(200),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal('agentModel'),
      args: z
        .object({
          slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
          model: z.string().regex(CONTROL_MODEL_ID),
        })
        .strict(),
    })
    .strict(),
  ...WRITE_CALLS,
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
  // submissions writes its own record: the task's block (collectedAt, reply).
  if (!['hello', 'logins', 'facts', 'submissions'].includes(parsed.op))
    audit(req, parsed.op, answer, auditMore(parsed));
  return NextResponse.json(answer);
}

async function runOp(actor: SessionUser, call: z.infer<typeof Call>) {
  switch (call.op) {
    case 'hello':
      return { ok: true, path: CONTROL_PATH };
    case 'logins':
      return { logins: await listLogins() };
    case 'facts':
      return collectFacts(actor.id);
    case 'disable':
      return disableLogins(actor, unique(call.args.loginIds));
    case 'enable':
      return enableLogins(actor, unique(call.args.loginIds));
    case 'archive':
      return archiveLogins(actor, unique(call.args.loginIds));
    case 'key':
      return setProviderKey(actor, call.args.service, call.args.value);
    case 'agentModel':
      return setAgentModel(actor.id, call.args.slug, call.args.model);
    case 'poolEntry':
    case 'updateNotice':
    case 'workerGroup':
      return runWrite(actor.id, call);
    case 'submissions':
      return submissionsCase(actor.id, call.args);
  }
}

/** The submissions case (submissions.ts): one of its four fixed shapes. */
function submissionsCase(
  ownerId: string,
  a: Extract<z.infer<typeof Call>, { op: 'submissions' }>['args'],
) {
  switch (a.do) {
    case 'list':
      return listForCenter(ownerId);
    case 'file':
      return fileForCenter(ownerId, a.taskId, a.fileId);
    case 'collected':
      return markCollected(ownerId, unique(a.taskIds));
    case 'reply':
      return replyFromCenter(ownerId, a);
  }
}

const unique = (ids: string[]) => [...new Set(ids.map((id) => id.toLowerCase()))];

/** The control-center actor handed to the users area's change, as SCIM's:
 *  the brain (its anchor) owns what the change touches. Null on a box with
 *  no original account yet. */
async function controlCaller(): Promise<SessionUser | null> {
  const anchor = await loadAnchorId();
  if (!anchor) return null;
  return {
    id: anchor,
    email: CONTROL_ACTOR,
    actor: { id: anchor, email: CONTROL_ACTOR, displayName: 'Control Center', isOwner: false },
  };
}

/** What a write's audit row names beyond the answer: the model, or the
 *  change itself (no write case carries a secret). */
function auditMore(call: z.infer<typeof Call>): Record<string, unknown> {
  if (call.op === 'agentModel') return { model: call.args.model };
  if (call.op === 'poolEntry' || call.op === 'updateNotice' || call.op === 'workerGroup') {
    return { change: call.args };
  }
  return {};
}

function audit(req: Request, op: Op, answer: unknown, more: Record<string, unknown> = {}) {
  auditFireAndForget({
    actorId: null,
    actorEmail: CONTROL_ACTOR,
    action: 'user.update',
    method: req.method,
    path: CONTROL_PATH,
    detail: { via: 'control', op, result: answer, ...more },
    ...requestMetaFrom(req),
  });
}

// --- key ---------------------------------------------------------------------

/** Whether `service` is on this box's own fixed list: an AI provider, or a
 *  key service the box knows (the Keys screen's rows). */
export function isFleetKeyService(service: string): boolean {
  return getProvider(service) !== null || KNOWN_KEY_SERVICES.some((k) => k.service === service);
}

/** What a key call answers: the service, and ok, or one fixed reason. */
export type KeyAnswer = {
  service: string;
  ok: boolean;
  reason?: 'service' | 'refused' | 'untested' | 'failed';
};

/**
 * Set the provider key `service` (its default label) to `value` as the Keys
 * screen does (via web: no hold), then test it. The vault writes its own
 * audit rows. ok: set and tested. Else one fixed reason, never the key or
 * the provider's text:
 *  - `service`: not on this box's list; nothing set.
 *  - `refused`: the vault said no, or the name holds a password, a login
 *    or an SSH key (never overwritten); nothing set.
 *  - `untested`: set; this service has no test (canProbeService).
 *  - `failed`: the provider refused the new key, or could not be reached.
 *    The box is put back exactly as it was: the old key, or no row at all
 *    (so a key under another label is used again), and a wrong key sent to
 *    the fleet stops no box.
 */
async function setProviderKey(
  actor: SessionUser,
  service: string,
  value: string,
): Promise<KeyAnswer> {
  if (!isFleetKeyService(service)) return { service, ok: false, reason: 'service' };
  const who: VaultActor = { loginId: actor.id, email: CONTROL_ACTOR, via: 'web' };
  const ref = { name: service };
  const row = await defaultKeyRow(actor.id, service);
  if (row && row.kind !== 'token') return { service, ok: false, reason: 'refused' };
  const before = row ? ((await getApiKeyById(row.id))?.apiKey ?? null) : null;
  let made: string;
  try {
    made = (await setVaultKey(who, actor.id, { ref, value, addKind: 'token' }))!.key.id;
  } catch {
    return { service, ok: false, reason: 'refused' };
  }
  if (!canProbeService(service)) return { service, ok: false, reason: 'untested' };
  const tested = await testVaultKey(who, actor.id, ref).catch(() => null);
  if (tested?.ok === true) return { service, ok: true };
  try {
    if (before !== null) {
      if (before !== value) await setVaultKey(who, actor.id, { ref, value: before });
    } else {
      await deleteVaultKey(who, actor.id, { id: made });
    }
  } catch (err) {
    log('control').error(`the key ${service} could not be put back:`, errorMessage(err));
  }
  return { service, ok: false, reason: 'failed' };
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
