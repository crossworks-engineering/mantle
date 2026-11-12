/**
 * The control service's side of the admin channel (docs/control-center.md,
 * "The admin channel"). CC code: only the control service loads it, through
 * run.ts.
 *
 * At the start of a box's run, after its key job: each call a CC Admin
 * queued (the Fleet tool route, control_tool_call, control_tool_list) is
 * taken once (takeControlToolCalls: marked sent, its sealed args dropped
 * from the row), sent in the signed `tool` or `tools` case, and answered.
 * The call's id is its nonce at the box. The box's answer is held to its
 * shape (anything else is `bad-reply`) and its size; a call that fails is
 * its code (unreachable, scope, http-NNN, ...), never sent again: a tool
 * may write what is not idempotent, so the asker sends it again if they
 * want.
 */
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { open } from '@mantle/crypto';
import {
  controlToolAad,
  saveControlToolAnswer,
  takeControlToolCalls,
  type ControlBoxRow,
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

/** The box's waiting admin channel calls, each sent once. Never throws. */
export async function sendToolCalls(key: KeyObject, box: ControlBoxRow): Promise<void> {
  let calls;
  try {
    calls = await takeControlToolCalls(box.id);
  } catch (err) {
    log('control').error(`box ${box.id} tool calls not taken:`, err);
    return;
  }
  for (const c of calls) {
    let answer: Parameters<typeof saveControlToolAnswer>[2];
    try {
      if (c.kind === 'tools') {
        const r = ToolsReply.safeParse(
          await callBox(key, box.url, 'tools', {}, { maxBytes: TOOL_REPLY_CAP_BYTES, long: true }),
        );
        if (!r.success) throw new CallFailed('bad-reply');
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
        answer = {
          ok: r.data.ok,
          reason: r.data.ok ? null : (r.data.reason ?? 'refused'),
          output: r.data.output ?? null,
          ...(r.data.error !== undefined ? { error: r.data.error } : {}),
          ...(r.data.truncated ? { truncated: true } : {}),
        };
      }
    } catch (err) {
      const code = err instanceof CallFailed ? err.code : 'error';
      if (!(err instanceof CallFailed)) log('control').error(`box ${box.id} tool call:`, err);
      answer = { ok: false, reason: code };
    }
    log('control').info(
      `box ${box.id}: ${c.kind} ${c.name ?? ''} ${answer.ok ? 'ok' : (answer.reason ?? 'not ok')}`,
    );
    await saveControlToolAnswer(box.id, c.id, answer).catch((e) =>
      log('control').error('saving a tool answer:', e),
    );
  }
}
