/**
 * The control service's side of the admin channel (docs/control-center.md,
 * "The admin channel"). CC code: only the control service loads it, through
 * run.ts.
 *
 * After the ban part of a box's run: each call a CC Admin
 * queued (the Fleet tool route, control_tool_call, control_tool_list) is
 * taken once (takeControlToolCalls: marked sent, its sealed args dropped
 * from the row), sent in the signed `tool` or `tools` case, and answered.
 * The call's id is its nonce at the box. The box's answer is held to its
 * shape (anything else is `bad-reply`) and its size; a call that fails is
 * its code (unreachable, scope, http-NNN, ...), never sent again: a tool
 * may write what is not idempotent, so the asker sends it again if they
 * want.
 *
 * A company sign-in call (kind `sso`) goes the same way as its own fixed
 * case (sso_status, sso_set, sso_test, sso_mode; the box's sso-channel.ts):
 * sso_set's and sso_mode's args are opened here, sent once with the call's
 * id as the nonce and the asker as `by`, and held in memory only. Its answer is also kept as the
 * box's sign-in view (saveControlSsoView): never a value of the secret.
 *
 * An invite call (kind `invite`; the box's invite-channel.ts) goes the same
 * way as its own fixed case: the email and the asker's one-time public key
 * are opened here and sent once. The answer is held to its shape: the code
 * locked to that key (`sealed`, which only the asking web process can
 * open) and when the invite ends, or a reason. The code is never in plain
 * text here, in the row or in a log.
 *
 * A key test call (kind `keys`; the box's key-status.ts) goes the same way
 * as its own fixed case, `keyTest`, with no args: the box tests the provider
 * keys it holds and answers its key lines, held here to their shape
 * (run.ts KeyLines: a print to its pattern, never a key).
 */
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { open } from '@mantle/crypto';
import {
  CONTROL_SSO_CASES,
  controlToolAad,
  saveControlSsoView,
  saveControlToolAnswer,
  takeControlToolCalls,
  type ControlBoxRow,
  type ControlSsoCase,
} from '@mantle/db/control-center';
import { UUID_RE } from '@mantle/std';
import { ssoLabelValue } from '@mantle/client-types/sso-label';
import { log } from '@mantle/tracing';
import { CallFailed, callBox } from './run';
import { KeyLines } from './key-lines';

/** A tool's answer (the box holds its output to 64,000 characters) and a
 *  tools list (a few hundred schemas) both fit well inside this. */
const TOOL_REPLY_CAP_BYTES = 2 * 1024 * 1024;

const Reason = z.string().regex(/^[a-z][a-z-]{0,19}$/);

const ToolReply = z
  .object({
    name: z.string().max(80),
    ok: z.boolean(),
    reason: Reason.optional(),
    output: z.unknown().optional(),
    error: z.string().max(2000).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

const ToolsReply = z
  .object({
    scope: z.enum(['admin', 'full']).nullable(),
    tools: z
      .array(
        z
          .object({
            name: z.string().max(80),
            description: z.string().max(600),
            effect: z.string().max(20),
            inputSchema: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

/** A string held to `re`: one that does not fit is kept as ''. */
const held = (re: RegExp) => z.string().transform((v) => (re.test(v) ? v : ''));
const Source = z.enum(['env', 'row', 'none']);
const Count = z.number().int().min(0).max(1_000_000).nullable();

/** A box's sign-in status, every string held to a pattern, so a box's free
 *  text never reaches the page. */
const Mode = z.enum(['off', 'setup', 'optional', 'required']);
const SsoStatus = z
  .object({
    mode: Mode,
    // Absent from a box a release behind (0372).
    modeFrom: Source.optional(),
    tenant: held(UUID_RE).nullable(),
    issuer: held(/^https?:\/\/[!-~]{1,390}$/),
    issuerFrom: Source,
    clientId: held(/^[!-~]{1,200}$/),
    clientIdFrom: Source,
    // Absent from a box a release behind (0399). A .env label that does not
    // fit the screens' pattern shows as ''.
    label: z
      .string()
      .transform((v) => ssoLabelValue(v) || '')
      .optional(),
    labelFrom: Source.optional(),
    secret: Source,
    secretSetAt: held(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/).nullable(),
    redirectUri: held(/^https?:\/\/[!-~]{1,390}$/),
    missing: z
      .array(z.enum(['MANTLE_OIDC_ISSUER', 'MANTLE_OIDC_CLIENT_ID', 'MANTLE_PUBLIC_URL']))
      .max(3),
    linked: Count,
    active: Count,
  })
  .strict();

const SsoReply = z
  .object({
    ok: z.boolean(),
    reason: Reason.optional(),
    test: z
      .string()
      .regex(/^[a-z][a-z-]{0,29}$/)
      .optional(),
    secretCleared: z.literal(true).optional(),
    acceptedUnclear: z.literal(true).optional(),
    from: Mode.optional(),
    status: SsoStatus.optional(),
  })
  .strict();

/** The box's answer to an invite: the locked code is base64 of one RSA
 *  block (2048 to 4096 bits), the end an ISO time. */
const InviteReply = z
  .object({
    ok: z.boolean(),
    reason: Reason.optional(),
    sealed: z
      .string()
      .regex(/^[A-Za-z0-9+/]{300,700}={0,2}$/)
      .optional(),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
      .optional(),
  })
  .strict();

/** The box's answer to keyTest: its fresh key lines, or a reason. */
const KeyTestReply = z.union([
  z.object({ ok: z.literal(true), keys: KeyLines }).strict(),
  z.object({ ok: z.literal(false), reason: Reason }).strict(),
]);

/** One key test call, sent: the box's fresh key lines, or its reason. */
async function sendKeyTestCall(
  key: KeyObject,
  box: ControlBoxRow,
): Promise<Parameters<typeof saveControlToolAnswer>[2]> {
  const r = KeyTestReply.safeParse(await callBox(key, box.url, 'keyTest'));
  if (!r.success) throw new CallFailed('bad-reply');
  if (!r.data.ok) return { ok: false, reason: r.data.reason };
  return { ok: true, reason: null, output: { keys: r.data.keys } };
}

/** One invite call, sent: the locked code and its end, or a reason. */
async function sendInviteCall(
  key: KeyObject,
  box: ControlBoxRow,
  c: { id: string; sealed: string | null; by: string },
): Promise<Parameters<typeof saveControlToolAnswer>[2]> {
  if (!c.sealed) throw new CallFailed('bad-call');
  const asked = JSON.parse(open(Buffer.from(c.sealed, 'base64'), controlToolAad(box.id, c.id))) as {
    email?: unknown;
    key?: unknown;
  };
  const r = InviteReply.safeParse(
    await callBox(key, box.url, 'invite', {
      nonce: c.id,
      by: c.by.slice(0, 200),
      email: String(asked.email ?? ''),
      key: String(asked.key ?? ''),
    }),
  );
  if (!r.success || (r.data.ok && (!r.data.sealed || !r.data.expiresAt))) {
    throw new CallFailed('bad-reply');
  }
  if (!r.data.ok) return { ok: false, reason: r.data.reason ?? 'refused' };
  return { ok: true, reason: null, output: { sealed: r.data.sealed, expiresAt: r.data.expiresAt } };
}

/** What a sign-in call carried, for its view: the fields a save carried,
 *  and the mode a raise asked. Never a value of the secret. */
type SsoSent = { fields: string[]; to?: string };

/** One sign-in call, sent: its answer, and what it carried (`sent`). The
 *  secret is opened here and dropped with this call's frame. */
async function sendSsoCall(
  key: KeyObject,
  box: ControlBoxRow,
  c: { id: string; name: string | null; sealed: string | null; by: string },
  sent: SsoSent,
): Promise<Parameters<typeof saveControlToolAnswer>[2]> {
  const name = c.name as ControlSsoCase;
  if (!CONTROL_SSO_CASES.includes(name)) throw new CallFailed('bad-call');
  let args: Record<string, unknown> = {};
  if (name === 'sso_set' || name === 'sso_mode') {
    if (!c.sealed) throw new CallFailed('bad-call');
    const staged = JSON.parse(
      open(Buffer.from(c.sealed, 'base64'), controlToolAad(box.id, c.id)),
    ) as Record<string, unknown>;
    // The fields a save carries; the confirm flag is not a value.
    if (name === 'sso_set')
      sent.fields.push(...Object.keys(staged).filter((k) => k !== 'acceptUnclear'));
    else sent.to = typeof staged.mode === 'string' ? staged.mode : '';
    args = { nonce: c.id, by: c.by.slice(0, 200), ...staged };
  }
  let reply: unknown;
  try {
    reply = await callBox(key, box.url, name, { ...args, withLabel: true });
  } catch (err) {
    // A box a release behind (0399) refuses the label flag as bad-call,
    // before it takes the nonce: ask once more without it. Not for a save
    // that carries a label or the unclear confirm: that save cannot apply
    // there, so none of it does (bad-call), never a save without the confirm.
    if (
      !(err instanceof CallFailed) ||
      err.code !== 'bad-call' ||
      'label' in args ||
      'acceptUnclear' in args
    ) {
      throw err;
    }
    reply = await callBox(key, box.url, name, args);
  }
  const r = SsoReply.safeParse(reply);
  if (!r.success) throw new CallFailed('bad-reply');
  return { ok: r.data.ok, reason: r.data.ok ? null : (r.data.reason ?? 'refused'), output: r.data };
}

/** The CC's own hold on an answer, whatever the box sent: a tool's output
 *  at most this many characters of JSON (else its head, marked truncated),
 *  a tools list at most TOOLS_MAX_CHARS. */
const OUTPUT_MAX_CHARS = 64_000;
const OUTPUT_HEAD_CHARS = 8_000;
const TOOLS_MAX_CHARS = 1_000_000;

function heldOutput(output: unknown): { output: unknown; truncated?: true } {
  const text = JSON.stringify(output ?? null) ?? 'null';
  if (text.length <= OUTPUT_MAX_CHARS) return { output: output ?? null };
  return { output: text.slice(0, OUTPUT_HEAD_CHARS), truncated: true };
}

/** The box's waiting admin channel calls, each sent once, after the ban
 *  part of its run. With `unsent` (the box did not answer the run) each is
 *  answered with that code, with no call; after the first call the box
 *  does not answer (unreachable), the rest get that code too, so a hung box
 *  costs one timeout. Never throws. */
export async function sendToolCalls(
  key: KeyObject,
  box: ControlBoxRow,
  unsent?: string,
): Promise<void> {
  let skip = unsent ?? null;
  let calls;
  try {
    calls = await takeControlToolCalls(box.id);
  } catch (err) {
    log('control').error(`box ${box.id} tool calls not taken:`, err);
    return;
  }
  for (const c of calls) {
    let answer: Parameters<typeof saveControlToolAnswer>[2];
    const sent: SsoSent = { fields: [] };
    if (skip !== null) {
      answer = { ok: false, reason: skip };
      await saveControlToolAnswer(box.id, c.id, answer).catch((e) =>
        log('control').error('saving a tool answer:', e),
      );
      if (c.kind === 'sso') await saveSso(box.id, c, sent, answer);
      continue;
    }
    try {
      if (c.kind === 'sso') {
        answer = await sendSsoCall(key, box, c, sent);
      } else if (c.kind === 'invite') {
        answer = await sendInviteCall(key, box, c);
      } else if (c.kind === 'keys') {
        answer = await sendKeyTestCall(key, box);
      } else if (c.kind === 'tools') {
        const r = ToolsReply.safeParse(
          await callBox(key, box.url, 'tools', {}, { maxBytes: TOOL_REPLY_CAP_BYTES, long: true }),
        );
        if (!r.success || JSON.stringify(r.data).length > TOOLS_MAX_CHARS) {
          throw new CallFailed('bad-reply');
        }
        answer = {
          ok: r.data.scope !== null,
          reason: r.data.scope ? null : 'scope',
          output: r.data,
        };
      } else {
        if (!c.sealed || !c.name) throw new CallFailed('bad-call');
        const args = JSON.parse(
          open(Buffer.from(c.sealed, 'base64'), controlToolAad(box.id, c.id)),
        ) as Record<string, unknown>;
        const r = ToolReply.safeParse(
          await callBox(
            key,
            box.url,
            'tool',
            { nonce: c.id, name: c.name, args },
            { maxBytes: TOOL_REPLY_CAP_BYTES, long: true },
          ),
        );
        if (!r.success || r.data.name !== c.name) throw new CallFailed('bad-reply');
        const held = heldOutput(r.data.output);
        answer = {
          ok: r.data.ok,
          reason: r.data.ok ? null : (r.data.reason ?? 'refused'),
          output: held.output,
          ...(r.data.error !== undefined ? { error: r.data.error } : {}),
          ...(r.data.truncated || held.truncated ? { truncated: true } : {}),
        };
      }
    } catch (err) {
      const code = err instanceof CallFailed ? err.code : 'error';
      // A sign-in call's error is named, never printed: its frame held the
      // plain secret.
      if (!(err instanceof CallFailed)) {
        if (c.kind === 'sso') log('control').error(`box ${box.id} sign-in call failed`);
        else if (c.kind === 'invite') log('control').error(`box ${box.id} invite call failed`);
        else log('control').error(`box ${box.id} tool call:`, err);
      }
      answer = { ok: false, reason: code };
      if (code === 'unreachable') skip = code;
    }
    log('control').info(
      `box ${box.id}: ${c.kind} ${c.name ?? ''} ${answer.ok ? 'ok' : (answer.reason ?? 'not ok')}`,
    );
    await saveControlToolAnswer(box.id, c.id, answer).catch((e) =>
      log('control').error('saving a tool answer:', e),
    );
    if (c.kind === 'sso') await saveSso(box.id, c, sent, answer);
  }
}

/** A sign-in answer into the box's view. Never throws. */
async function saveSso(
  boxId: string,
  c: { name: string | null; by: string },
  sent: SsoSent,
  answer: Parameters<typeof saveControlToolAnswer>[2],
): Promise<void> {
  const out = (answer.output ?? {}) as {
    test?: string;
    from?: string;
    acceptedUnclear?: true;
    status?: never;
  };
  await saveControlSsoView(
    boxId,
    { name: c.name ?? '', by: c.by, fields: sent.fields, ...(sent.to ? { to: sent.to } : {}) },
    {
      ok: answer.ok ?? false,
      reason: answer.reason ?? null,
      ...(out.test ? { test: out.test } : {}),
      ...(out.from ? { from: out.from } : {}),
      ...(out.acceptedUnclear ? { acceptedUnclear: true } : {}),
      ...(out.status ? { status: out.status } : {}),
    },
  ).catch((e) => log('control').error('saving a sign-in view:', e));
}
