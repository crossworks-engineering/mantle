/**
 * The control service's run (docs/control-center.md, plan sections 3.1 and
 * 6). It runs on the Control Center only, in its own container, which holds
 * the private key. For each box due a run (asked for by the brain, or not
 * run for 5 minutes), 8 at a time:
 *
 *   1. logins: the box's login list (ids, emails, flags, sign-in ids);
 *   2. the match, here (planBox): the bans never leave the CC;
 *   3. archive, disable and enable with login ids only.
 *
 * The service decides every call from the ban rows itself: what asks for a
 * run carries no op and no argument, so it is never a signing oracle.
 *
 * Outbound rules (egressFetch): https only (the URL is checked when it is
 * added), no redirect followed, a 10 second timeout, a reply size cap,
 * certificate checks on (the runtime's default, never turned off here), and
 * no link-local or metadata address.
 */
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  planBox,
  runControlBans,
  saveControlRun,
  takeDueControlBoxes,
  type ControlBan,
  type ControlBox,
} from '@mantle/db';
import type { ControlLogin } from '@mantle/db';
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
        timeoutMs: NET_TIMEOUTS.controlCall,
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

/** One box's run. Never throws: a failure is the box's reason code. */
export async function runBox(key: KeyObject, box: ControlBox, bans: ControlBan[]): Promise<void> {
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
  }
}

/** One tick: every box due a run, PARALLEL at a time. */
export async function runDueBoxes(key: KeyObject): Promise<number> {
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
