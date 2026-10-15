/**
 * No turn hands the model (and from it the person) the database's or the
 * runtime's own text (the A8 finding F2): an assistant turn on every
 * surface, a run item and an approved pending call run under the one
 * masking in dispatch, the owner's turn too. A database error says the one
 * mapper's words; a scope guard's or a stack's words (withSystemTx, a lost
 * turn scope, a stack trace) say RUNTIME_ERROR_PUBLIC; the detail stays in
 * the server log. An error of the tool's own keeps its text.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';
import { DATABASE_ERROR_PUBLIC, RUNTIME_ERROR_PUBLIC } from '@mantle/std';
import { dispatchTool } from './dispatch';
import { pendingCaller, runCaller, turnCaller } from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { registerBuiltin } from './registry';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const SQL = 'Failed query: update "nodes" set "title" = $1 where "nodes"."id" = $2\nparams: x,4f1c';
const SYSTEM_TX = 'withSystemTx: only outside a viewer scope and any other transaction';
const STACK = 'boom\n    at runInTurnScope (/srv/packages/db/src/viewer.ts:812:11)';

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
      throw new Error(SYSTEM_TX);
    }),
  );
  registerBuiltin(
    probe('turn_probe_reply', () => ({ ok: false, error: `nothing moved: ${SYSTEM_TX}` })),
  );
  registerBuiltin(probe('turn_probe_stack', () => ({ ok: false, error: STACK })));
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
          turn_probe_stack: RUNTIME_ERROR_PUBLIC,
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
