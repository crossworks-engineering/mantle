/**
 * No turn hands the model (and from it the person) the database's or the
 * runtime's own text (the A8 finding F2): an assistant turn on every
 * surface, a run item and an approved pending call run under the one
 * masking in dispatch, the owner's turn too. A database error says the one
 * mapper's words; a runtime fault (RuntimeFaultError: withSystemTx, a lost
 * turn scope), thrown or repeated in a reply, says RUNTIME_ERROR_PUBLIC; the
 * detail stays in the server log. An error of the tool's own keeps its text,
 * and so does a third party's output with the same words (a shell tool's
 * stderr with a stack, an outside Postgres's constraint text behind a
 * connector; fix round 1 M2): the model reads it and can fix its call.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';
import {
  DATABASE_ERROR_PUBLIC,
  errorMessage,
  RUNTIME_ERROR_PUBLIC,
  RuntimeFaultError,
} from '@mantle/std';
import { dispatchTool } from './dispatch';
import { pendingCaller, runCaller, turnCaller } from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { registerBuiltin } from './registry';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const SQL = 'Failed query: update "nodes" set "title" = $1 where "nodes"."id" = $2\nparams: x,4f1c';
const SYSTEM_TX = 'withSystemTx: only outside a viewer scope and any other transaction';
const STACK = 'shell exited with 1: boom\nstderr:\nError: x\n    at fn (/home/u/app.js:812:11)';
const OUTSIDE_PG =
  'null value in column "name" of relation "items" violates not-null constraint (SQLSTATE 23502)';

function probe(slug: string, fail: () => never | { ok: false; error: string }): BuiltinToolDef {
  return {
    slug,
    name: slug,
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    policy: { effect: 'read', spends: 'none', scope: 'any' },
    readOnly: true,
    handler: async () => fail(),
  };
}

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;

beforeAll(() => {
  ensureGateReady();
  registerBuiltin(
    probe('turn_probe_db', () => {
      throw Object.assign(new Error(SQL), {
        cause: Object.assign(new Error('permission denied for table nodes'), {
          code: '42501',
          severity: 'ERROR',
        }),
      });
    }),
  );
  registerBuiltin(
    probe('turn_probe_system_tx', () => {
      throw new RuntimeFaultError(SYSTEM_TX);
    }),
  );
  registerBuiltin(
    probe('turn_probe_reply', () => {
      try {
        throw new RuntimeFaultError(SYSTEM_TX);
      } catch (e) {
        return { ok: false, error: `nothing moved: ${errorMessage(e)}` };
      }
    }),
  );
  // A third party's words (fix round 1 M2): they pass through.
  registerBuiltin(probe('turn_probe_stack', () => ({ ok: false, error: STACK })));
  registerBuiltin(probe('turn_probe_outside_pg', () => ({ ok: false, error: OUTSIDE_PG })));
  registerBuiltin(probe('turn_probe_guard_words', () => ({ ok: false, error: SYSTEM_TX })));
  registerBuiltin(
    probe('turn_probe_plain', () => {
      throw new Error('the sheet has no tab named X');
    }),
  );
});

const CALLS: Array<[string, Pick<ToolHandlerContext, 'surface' | 'caller'>]> = [
  [
    'a web turn (the owner’s too)',
    { surface: { kind: 'web', loginId: 'l1' }, caller: turnCaller() },
  ],
  ['a team turn', { surface: { kind: 'team', loginId: 'l1' }, caller: turnCaller() }],
  [
    'a Telegram turn',
    { surface: { kind: 'telegram', telegramChatId: '1', loginId: 'l1' }, caller: turnCaller() },
  ],
  ['a run item', { caller: runCaller() }],
  ['an approved pending call', { caller: pendingCaller() }],
];

describe('a turn never answers the database’s or the runtime’s own text (A8 F2)', () => {
  for (const [name, ctx] of CALLS) {
    it(`${name}: a fixed text, the detail in the log`, async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const answers: Record<string, string> = {};
        for (const slug of [
          'turn_probe_db',
          'turn_probe_system_tx',
          'turn_probe_reply',
          'turn_probe_stack',
          'turn_probe_outside_pg',
          'turn_probe_guard_words',
          'turn_probe_plain',
        ]) {
          const res = await dispatchTool(row(slug), {}, { ownerId: 'o', ...ctx });
          expect(res.ok, slug).toBe(false);
          answers[slug] = (res as { error: string }).error;
        }
        expect(answers).toEqual({
          turn_probe_db: DATABASE_ERROR_PUBLIC,
          turn_probe_system_tx: RUNTIME_ERROR_PUBLIC,
          turn_probe_reply: RUNTIME_ERROR_PUBLIC,
          turn_probe_stack: STACK,
          turn_probe_outside_pg: OUTSIDE_PG,
          turn_probe_guard_words: SYSTEM_TX,
          turn_probe_plain: 'the sheet has no tab named X',
        });
        // The detail is in the server log.
        expect(log.mock.calls.flat().join(' ')).toContain('withSystemTx');
      } finally {
        log.mockRestore();
      }
    });
  }
});
