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
    if (skip !== null) {
      await saveControlToolAnswer(box.id, c.id, { ok: false, reason: skip }).catch((e) =>
        log('control').error('saving a tool answer:', e),
      );
      continue;
    }
    try {
      if (c.kind === 'tools') {
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
      if (!(err instanceof CallFailed)) log('control').error(`box ${box.id} tool call:`, err);
      answer = { ok: false, reason: code };
      if (code === 'unreachable') skip = code;
    }
    log('control').info(
      `box ${box.id}: ${c.kind} ${c.name ?? ''} ${answer.ok ? 'ok' : (answer.reason ?? 'not ok')}`,
    );
    await saveControlToolAnswer(box.id, c.id, answer).catch((e) =>
      log('control').error('saving a tool answer:', e),
    );
  }
}
