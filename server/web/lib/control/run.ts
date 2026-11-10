/**
 * The control service's run (docs/control-center.md, plan sections 3.1 and
 * 6). It runs on the Control Center only, in its own container, which holds
 * the private key. For each box due a run (asked for by the brain, or not
 * run for 5 minutes), 8 at a time:
 *
 *   1. logins: the box's login list (ids, emails, flags, sign-in ids);
 *   2. the match, here (planBox): the bans never leave the CC;
 *   3. archive, disable and enable with login ids only;
 *   4. a provider key the box is queued for (phase 2), sent once and its
 *      job cleared whatever the box answers: the CC holds a key only until
 *      it is sent;
 *   5. a write job (phase 4): each fleet write (an agent model, a pool
 *      entry, the update notice, a worker group) sent once, then taken off;
 *   6. facts (phase 3, the fleet matrix): numbers, settings and model ids.
 * 5 and 6 come after the ban part, and only to a box that answered it.
 *
 * The service decides every call from the ban rows itself: what asks for a
 * run carries no op and no argument, so it is never a signing oracle.
 *
 * Outbound rules (egressFetch): https only (the URL is checked when it is
 * added), no redirect followed, a 10 second timeout, a reply size cap,
 * certificate checks on (the runtime's default, never turned off here), and
 * no link-local or metadata address.
 *
 * CC code: only the control service loads it, after its flag check
 * (workers/control.ts).
 */
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { open } from '@mantle/crypto';
import {
  controlKeyAad,
  expireControlKeyJobs,
  planBox,
  runControlBans,
  saveControlFacts,
  saveControlKeyResult,
  saveControlWriteResult,
  expireControlWriteJobs,
  saveControlRun,
  takeDueControlBoxes,
  type ControlBan,
  type ControlBoxRow,
} from '@mantle/db/control-center';
import {
  CONTROL_FACTS_MAX_ROWS,
  CONTROL_MODEL_ID,
  type ControlFacts,
  type ControlLogin,
  type ControlWriteAnswer,
} from '@mantle/db';
import { shapeBoxStatus } from '@mantle/tools/box-status';
import { log } from '@mantle/tracing';
import { NET_TIMEOUTS } from '@mantle/std';
import { EgressTooLargeError, egressFetch } from '@mantle/std/egress';
import { CONTROL_PATH, signCall } from './sign';

/** A login list of a few thousand logins fits well inside this. */
const REPLY_CAP_BYTES = 4 * 1024 * 1024;
const PARALLEL = 8;
/** The most login ids one call names (the box's own cap). */
const IDS_PER_CALL = 1000;

const LoginSchema = z.object({
  id: z.string().uuid(),
  email: z.string().max(400),
  owner: z.boolean(),
  disabled: z.boolean(),
  archived: z.boolean(),
  marked: z.boolean(),
  links: z.array(z.object({ issuer: z.string().max(400), oid: z.string().max(200) })).max(50),
});
const LoginsReply = z.object({ logins: z.array(LoginSchema).max(100_000) });
const Count = z.number().int().min(0).max(1_000_000);
/** The box's answer to disable, enable or archive: counts and the owner
 *  ids, nothing else (a box's text never reaches the Fleet screen). */
const CountsReply = z
  .object({
    disabled: Count.optional(),
    enabled: Count.optional(),
    archived: Count.optional(),
    already: Count.optional(),
    notMarked: Count.optional(),
    notFound: Count.optional(),
    owner: z.array(z.string().uuid()).max(IDS_PER_CALL).optional(),
  })
  .strict();

/** A short code of why a call failed: the box's own reason (off, time,
 *  sig, size, bad-call, not-set-up), or the network's. */
class CallFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** One signed call to one box. */
export async function callBox(
  key: KeyObject,
  boxUrl: string,
  op: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const origin = new URL(boxUrl).origin;
  if (!origin.startsWith('https://')) throw new CallFailed('not-https');
  const body = Buffer.from(JSON.stringify({ op, args }));
  let res: Response;
  let text: string;
  try {
    // An Admin typed the box URL: a private or tailnet address may be a
    // box (allowLan); link-local and metadata addresses stay refused.
    res = await egressFetch(
      `${origin}${CONTROL_PATH}`,
      {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...signCall(key, origin, body) },
      },
      {
        timeoutMs: op === 'key' ? NET_TIMEOUTS.controlKeyCall : NET_TIMEOUTS.controlCall,
        maxBytes: REPLY_CAP_BYTES,
        redirect: 'error',
        allowLan: true,
      },
    );
    text = await res.text();
  } catch (err) {
    throw new CallFailed(err instanceof EgressTooLargeError ? 'reply-too-large' : 'unreachable');
  }
  if (!res.ok) {
    let reason = `http-${res.status}`;
    try {
      const r = (JSON.parse(text) as { reason?: unknown }).reason;
      if (typeof r === 'string' && /^[a-z-]{1,20}$/.test(r)) reason = r;
    } catch {
      // the status alone
    }
    // A 404 is a box with no control lines in its .env.
    if (res.status === 404) reason = 'off';
    throw new CallFailed(reason);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CallFailed('bad-reply');
  }
}

async function callIds(
  key: KeyObject,
  url: string,
  op: 'disable' | 'enable' | 'archive',
  ids: string[],
): Promise<Record<string, number | string[]>> {
  const total: Record<string, number | string[]> = {};
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
    const r = CountsReply.safeParse(
      await callBox(key, url, op, { loginIds: ids.slice(i, i + IDS_PER_CALL) }),
    );
    if (!r.success) throw new CallFailed('bad-reply');
    for (const [k, v] of Object.entries(r.data)) {
      const was = total[k];
      if (Array.isArray(v)) total[k] = [...(Array.isArray(was) ? was : []), ...v];
      else total[k] = (typeof was === 'number' ? was : 0) + v;
    }
  }
  return total;
}

const KeyReply = z
  .object({
    service: z.string().max(64),
    ok: z.boolean(),
    reason: z.enum(['service', 'refused', 'untested', 'failed']).optional(),
  })
  .strict();

/** The box's key job, sent once. Never throws: the answer, or a reason
 *  code, is the box's key result, and the job is cleared either way. */
export async function sendKeyJob(key: KeyObject, box: ControlBoxRow): Promise<void> {
  const job = box.keyJob;
  if (!job) return;
  let ok = false;
  let reason: string | null;
  try {
    const value = open(Buffer.from(job.sealed, 'base64'), controlKeyAad(box.id));
    const r = KeyReply.safeParse(
      await callBox(key, box.url, 'key', { service: job.service, value }),
    );
    if (!r.success || r.data.service !== job.service) throw new CallFailed('bad-reply');
    ok = r.data.ok;
    reason = r.data.reason ?? null;
  } catch (err) {
    reason = err instanceof CallFailed ? err.code : 'error';
    if (!(err instanceof CallFailed)) log('control').error(`box ${box.id} key job failed:`, err);
  }
  log('control').info(`box ${box.id}: key ${job.service} ${ok ? 'ok' : (reason ?? 'not ok')}`);
  await saveControlKeyResult(box.id, job.at, {
    service: job.service,
    ok,
    reason,
    by: job.by,
    at: new Date().toISOString(),
  }).catch((e) => log('control').error('saving a key result:', e));
}

/** A string held to `re` (which holds its length too): one that does not
 *  fit is kept as '', so one odd model id never blanks a box's whole line.
 *  The reply cap bounds the body. */
const held = (re: RegExp) => z.string().transform((v) => (re.test(v) ? v : ''));
/** The box's own caps: a slug, role, kind or provider is a short id. */
const Slug = held(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
const ModelId = held(CONTROL_MODEL_ID);
const Stamp = held(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/);
/** At most CONTROL_FACTS_MAX_ROWS kept: a box with more is cut, not refused. */
const rows = <T extends z.ZodTypeAny>(row: T) =>
  z.array(row).transform((a) => a.slice(0, CONTROL_FACTS_MAX_ROWS));
/** The box's answer to facts (phase 3), held to its shape (anything else
 *  is a bad reply) and every string to a pattern, so a box's free text
 *  never reaches the matrix nor a model that reads it. `status` is
 *  re-shaped by box_status's own parser (schema 1, numbers only). */
const FactsReply = z
  .object({
    schema: z.literal(1),
    at: Stamp,
    status: z.unknown(),
    signIn: z.enum(['off', 'optional', 'required']),
    agents: rows(
      z
        .object({
          slug: Slug.nullable(),
          role: Slug,
          provider: Slug,
          model: ModelId,
          enabled: z.boolean(),
          assigned: z.boolean(),
        })
        .strict(),
    ),
    workers: rows(
      z.object({ kind: Slug, provider: Slug, model: ModelId, enabled: z.boolean() }).strict(),
    ),
    counts: z.object({ workspaces: Count, apps: Count }).strict(),
    backup: z
      .object({ lastRunAt: Stamp, ok: z.boolean(), lastSuccessAt: Stamp.nullable() })
      .strict()
      .nullable(),
  })
  .strict();

/** The box's facts, read once (the matrix). Never throws: the facts, or
 *  the reason code, are saved. */
export async function readFacts(key: KeyObject, box: ControlBoxRow): Promise<void> {
  let read: { facts: ControlFacts } | { reason: string };
  try {
    const r = FactsReply.safeParse(await callBox(key, box.url, 'facts'));
    if (!r.success) throw new CallFailed('bad-reply');
    read = {
      facts: {
        ...r.data,
        status: r.data.status ? shapeBoxStatus(r.data.status) : null,
        // A person's own assistant goes without its slug, whatever was sent.
        agents: r.data.agents.map((a) => (a.assigned ? { ...a, slug: null } : a)),
      },
    };
  } catch (err) {
    const code = err instanceof CallFailed ? err.code : 'error';
    if (!(err instanceof CallFailed)) log('control').error(`box ${box.id} facts failed:`, err);
    read = { reason: code };
  }
  await saveControlFacts(box.id, read).catch((e) => log('control').error('saving facts:', e));
}

/** A box's answer to one fleet write: ok and what it had, or one reason.
 *  agentModel names its slug back, the other cases their kind. */
const WriteReply = z
  .object({
    slug: z.string().max(64).optional(),
    kind: z.string().max(32).optional(),
    ok: z.boolean(),
    was: z.string().max(200).optional(),
    reason: z
      .string()
      .regex(/^[a-z][a-z-]{0,31}$/)
      .optional(),
  })
  .strict();

/** The box's write job (phase 4), each change sent once, then taken off
 *  the job whatever the box answers (changes queued meanwhile stay). With
 *  `unsent` (the box did not answer the run) every change gets that code,
 *  with no call; after the first call that fails (the network, or a reply
 *  out of shape), the rest get its code too, so a hung box costs one
 *  timeout, not forty. A change older than an hour never gets here: each
 *  tick drops it first (expireControlWriteJobs). Never throws. */
export async function sendWriteJob(
  key: KeyObject,
  box: ControlBoxRow,
  unsent?: string,
): Promise<void> {
  const changes = box.writeJob?.changes ?? [];
  if (changes.length === 0) return;
  let skip = unsent ?? null;
  const answers: ControlWriteAnswer[] = [];
  for (const c of changes) {
    let ok = false;
    let was: string | null = null;
    let reason: string | null = skip;
    if (skip === null) {
      try {
        const { kind, by, at, ...args } = c;
        void by;
        void at;
        const r = WriteReply.safeParse(await callBox(key, box.url, kind, args));
        if (!r.success) throw new CallFailed('bad-reply');
        const echo = c.kind === 'agentModel' ? r.data.slug === c.slug : r.data.kind === kind;
        if (!echo) throw new CallFailed('bad-reply');
        ok = r.data.ok;
        // The box's own word, held to a model id's pattern (a model, or
        // added, updated, on, off).
        was = r.data.was !== undefined && CONTROL_MODEL_ID.test(r.data.was) ? r.data.was : null;
        reason = ok ? null : (r.data.reason ?? 'refused');
      } catch (err) {
        reason = err instanceof CallFailed ? err.code : 'error';
        if (!(err instanceof CallFailed)) log('control').error(`box ${box.id} write job:`, err);
        skip = reason;
      }
    }
    answers.push({ ...c, ok, was, reason, done: new Date().toISOString() });
  }
  log('control').info(
    `box ${box.id}: writes ${answers.filter((r) => r.ok).length} of ${answers.length} done`,
  );
  await saveControlWriteResult(box.id, changes[0]!.at, answers).catch((e) =>
    log('control').error('saving a write result:', e),
  );
}

/** One box's run. Never throws: a failure is the box's reason code. */
export async function runBox(
  key: KeyObject,
  box: ControlBoxRow,
  bans: ControlBan[],
): Promise<void> {
  // The key first: it does not wait on the ban part, nor fail with it.
  await sendKeyJob(key, box);
  try {
    const listed = LoginsReply.safeParse(await callBox(key, box.url, 'logins'));
    if (!listed.success) throw new CallFailed('bad-reply');
    const logins: ControlLogin[] = listed.data.logins.map((l) => ({
      ...l,
      email: l.email.toLowerCase(),
    }));
    const plan = planBox(logins, bans);
    const result: Record<string, unknown> = { owner: plan.owners };
    if (plan.archive.length) result.archive = await callIds(key, box.url, 'archive', plan.archive);
    if (plan.disable.length) result.disable = await callIds(key, box.url, 'disable', plan.disable);
    if (plan.enable.length) result.enable = await callIds(key, box.url, 'enable', plan.enable);
    await saveControlRun(box.id, { reason: null, result, logins, perBan: plan.perBan });
    // A write job, then the matrix's read (which then shows the new
    // models), both after the ban part, which they never hold back.
    await sendWriteJob(key, box);
    await readFacts(key, box);
    if (plan.archive.length || plan.disable.length || plan.enable.length || plan.owners.length) {
      log('control').info(
        `box ${box.id}: archive ${plan.archive.length}, disable ${plan.disable.length}, enable ${plan.enable.length}, owner matched ${plan.owners.length}`,
      );
    }
  } catch (err) {
    const code = err instanceof CallFailed ? err.code : 'error';
    if (!(err instanceof CallFailed)) log('control').error(`box ${box.id} run failed:`, err);
    else log('control').warn(`box ${box.id}: ${code}`);
    await saveControlRun(box.id, { reason: code }).catch((e) =>
      log('control').error('saving a failed run:', e),
    );
    // No second call to a box that did not answer: the facts wait too,
    // and a write job is answered with the same code, unsent.
    await saveControlFacts(box.id, { reason: code }).catch((e) =>
      log('control').error('saving facts:', e),
    );
    await sendWriteJob(key, box, code);
  }
}

/** One tick: every box due a run, PARALLEL at a time. */
export async function runDueBoxes(key: KeyObject): Promise<number> {
  // A key job older than an hour is deleted unsent, never sent late.
  await expireControlKeyJobs();
  await expireControlWriteJobs();
  const boxes = await takeDueControlBoxes();
  if (boxes.length === 0) return 0;
  const bans = await runControlBans();
  let next = 0;
  const lane = async () => {
    while (next < boxes.length) {
      const box = boxes[next++]!;
      await runBox(key, box, bans);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, boxes.length) }, lane));
  return boxes.length;
}
