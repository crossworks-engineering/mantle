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
 * case (sso_status, sso_set, sso_test; the box's sso-channel.ts): sso_set's
 * args are opened here, sent once with the call's id as the nonce and the
 * asker as `by`, and held in memory only. Its answer is also kept as the
 * box's sign-in view (saveControlSsoView): never a value of the secret.
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
import { log } from '@mantle/tracing';
import { CallFailed, callBox } from './run';

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
const Guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Source = z.enum(['env', 'row', 'none']);
const Count = z.number().int().min(0).max(1_000_000).nullable();

/** A box's sign-in status, every string held to a pattern, so a box's free
 *  text never reaches the page. */
const SsoStatus = z
  .object({
    mode: z.enum(['off', 'setup', 'optional', 'required']),
    tenant: held(Guid).nullable(),
    issuer: held(/^https?:\/\/[!-~]{1,390}$/),
    issuerFrom: Source,
    clientId: held(/^[!-~]{1,200}$/),
    clientIdFrom: Source,
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
    status: SsoStatus.optional(),
  })
  .strict();

/** One sign-in call, sent: its answer, and the fields a save carried. The
 *  secret is opened here and dropped with this call's frame. */
async function sendSsoCall(
  key: KeyObject,
  box: ControlBoxRow,
  c: { id: string; name: string | null; sealed: string | null; by: string },
  fields: string[],
): Promise<Parameters<typeof saveControlToolAnswer>[2]> {
  const name = c.name as ControlSsoCase;
  if (!CONTROL_SSO_CASES.includes(name)) throw new CallFailed('bad-call');
  let args: Record<string, unknown> = {};
  if (name === 'sso_set') {
    if (!c.sealed) throw new CallFailed('bad-call');
    const staged = JSON.parse(
      open(Buffer.from(c.sealed, 'base64'), controlToolAad(box.id, c.id)),
    ) as Record<string, unknown>;
    fields.push(...Object.keys(staged));
    args = { nonce: c.id, by: c.by.slice(0, 200), ...staged };
  }
  const r = SsoReply.safeParse(await callBox(key, box.url, name, args));
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
    const fields: string[] = [];
    if (skip !== null) {
      answer = { ok: false, reason: skip };
      await saveControlToolAnswer(box.id, c.id, answer).catch((e) =>
        log('control').error('saving a tool answer:', e),
      );
      if (c.kind === 'sso') await saveSso(box.id, c, fields, answer);
      continue;
    }
    try {
      if (c.kind === 'sso') {
        answer = await sendSsoCall(key, box, c, fields);
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
    if (c.kind === 'sso') await saveSso(box.id, c, fields, answer);
  }
}

/** A sign-in answer into the box's view. Never throws. */
async function saveSso(
  boxId: string,
  c: { name: string | null; by: string },
  fields: string[],
  answer: Parameters<typeof saveControlToolAnswer>[2],
): Promise<void> {
  const out = (answer.output ?? {}) as { test?: string; status?: never };
  await saveControlSsoView(
    boxId,
    { name: c.name ?? '', by: c.by, fields },
    {
      ok: answer.ok ?? false,
      reason: answer.reason ?? null,
      ...(out.test ? { test: out.test } : {}),
      ...(out.status ? { status: out.status } : {}),
    },
  ).catch((e) => log('control').error('saving a sign-in view:', e));
}
