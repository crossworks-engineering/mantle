/**
 * A tool that throws a database error never hands its text to the MCP client
 * (workspaces W3, defence in depth): a Postgres or drizzle error can carry
 * SQL, parameters, or with a row rule in force something about a row the
 * caller may not read. Any other error is left to the SDK, as before. Since
 * A5 step 4 the one registration answers it (gated-tools.ts: step 8 of the
 * gate, @mantle/tools thrownToolDatabaseError), where addTool's catch did.
 */
import { describe, expect, it, vi } from 'vitest';

// No database: the brain reads as not on workspaces, so the anchor's call
// runs as is (mcp-scope.ts).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  brainOnWorkspacesNow: async () => false,
}));

import { z } from 'zod';
import { DATABASE_ERROR_PUBLIC, errorMessage } from '@mantle/std';
import { registerBuiltin, type BuiltinToolDef } from '@mantle/tools';
import { toolDatabaseError } from './tool-input';
import { makeRegisterContext } from './context';
import { registerGatedTool } from '../gated-tools';
import { defaultMcpGate } from '../gate-policy';

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;

/** A tool registered through the one registration (a hand-written one,
 *  `search`), its body `handler`. */
function registered(handler: Handler): Handler {
  let cb: Handler | undefined;
  const fake = { registerTool: (_n: string, _c: unknown, h: Handler) => (cb = h) };
  registerGatedTool(fake as never, defaultMcpGate('owner-1'), 'owner-1', {
    kind: 'definition',
    name: 'search',
    description: 'd',
    shape: { q: z.string() },
    run: handler as never,
  });
  return cb!;
}

describe('MCP tool errors from the database', () => {
  it('a drizzle error with a Postgres cause comes back generic, never its text', async () => {
    const err = Object.assign(
      new Error('Failed query: select secret_words from nodes\nparams: x'),
      {
        name: 'DrizzleQueryError',
        cause: Object.assign(new Error('invalid input near "quokka"'), {
          code: '22P02',
          severity: 'ERROR',
        }),
      },
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = (await registered(async () => {
      throw err;
    })({ q: 'x' }, {})) as { isError: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(`Error: ${DATABASE_ERROR_PUBLIC}`);
    expect(JSON.stringify(res)).not.toMatch(/secret_words|quokka|select/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a bare Postgres error is generic too; any other error is thrown as before', async () => {
    const pg = Object.assign(new Error('permission denied for table nodes'), {
      code: '42501',
      severity: 'ERROR',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = (await registered(async () => {
      throw pg;
    })({ q: 'x' }, {})) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).not.toContain('permission denied');
    spy.mockRestore();
    await expect(
      registered(async () => {
        throw new Error('node not found');
      })({ q: 'x' }, {}),
    ).rejects.toThrow('node not found');
  });

  it('a builtin that returns a database error as its reply text is generic too (callBuiltin)', async () => {
    const pg = Object.assign(new Error('duplicate key value violates "nodes_secret_key"'), {
      code: '23505',
      severity: 'ERROR',
    });
    const def = (handler: BuiltinToolDef['handler']) =>
      ({
        slug: 'probe',
        name: 'probe',
        description: 'probe',
        inputSchema: { type: 'object', properties: {} },
        policy: { effect: 'write', spends: 'none', scope: 'any' },
        handler,
      }) as BuiltinToolDef;
    const ctx = makeRegisterContext({} as never, 'owner-1', 'http');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = (d: BuiltinToolDef) => {
      registerBuiltin(d);
      return ctx.callBuiltin(d, {});
    };
    // The 134 builtins that answer { ok: false, error: errorMessage(err) }.
    const asIs = (await call(
      def(async () => ({ ok: false, error: `could not save: ${errorMessage(pg)}` })),
    )) as { content: Array<{ text: string }> };
    expect(asIs.content[0]!.text).toBe(`Error: ${DATABASE_ERROR_PUBLIC}`);
    // A friendly error of our own over a database cause keeps its words.
    const busy = new Error('Another change is under way; try again in a moment.', {
      cause: Object.assign(new Error('could not obtain lock'), {
        code: '55P03',
        severity: 'ERROR',
      }),
    });
    const friendly = (await call(def(async () => ({ ok: false, error: errorMessage(busy) })))) as {
      content: Array<{ text: string }>;
    };
    expect(friendly.content[0]!.text).toBe(`Error: ${busy.message}`);
    // A plain tool error is unchanged.
    const plain = (await call(def(async () => ({ ok: false, error: 'q is required' })))) as {
      content: Array<{ text: string }>;
    };
    expect(plain.content[0]!.text).toBe('Error: q is required');
    spy.mockRestore();
  });
});

describe('the one mapper on every tool exit (arch A3a fix round 3, N4)', () => {
  const refused = (detail: string, message = 'not allowed to change this item') =>
    Object.assign(new Error(message), { code: '42501', severity: 'ERROR', detail });
  const hidden = () => refused('hidden_rows', 'This folder holds items you cannot move.');
  const wrapped = (cause: Error) =>
    Object.assign(new Error('Failed query: update nodes set path = $1\nparams: x'), {
      name: 'DrizzleQueryError',
      cause,
    });

  it('toolDatabaseError: no_read is not found (D2), a folder holding hidden items says so, the rest is masked', () => {
    expect(toolDatabaseError(wrapped(refused('no_read')))).toBe('not found');
    expect(toolDatabaseError(wrapped(hidden()))).toBe('This folder holds items you cannot move.');
    expect(toolDatabaseError(refused('no_edit'))).toBe(DATABASE_ERROR_PUBLIC);
  });

  it('a thrown refusal (the one registration) answers the mapped words', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [err, words] of [
      [wrapped(hidden()), 'This folder holds items you cannot move.'],
      [wrapped(refused('no_read')), 'not found'],
    ] as const) {
      const res = (await registered(async () => {
        throw err;
      })({ q: 'x' }, {})) as { content: Array<{ text: string }> };
      expect(res.content[0]!.text).toBe(`Error: ${words}`);
    }
    spy.mockRestore();
  });

  it('the folder tools over MCP (callBuiltin): their { ok: false, error } reply answers the mapped words', async () => {
    const def = (handler: BuiltinToolDef['handler']) =>
      ({
        slug: 'folder_delete',
        name: 'folder_delete',
        description: 'probe',
        inputSchema: { type: 'object', properties: {} },
        policy: { effect: 'write', spends: 'none', scope: 'any' },
        handler,
      }) as BuiltinToolDef;
    const ctx = makeRegisterContext({} as never, 'owner-1', 'http');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = (d: BuiltinToolDef) => {
      registerBuiltin(d);
      return ctx.callBuiltin(d, {});
    };
    // tree_folder_delete, folder_move, folder_rename: catch and reply.
    const moved = (await call(
      def(async () => ({ ok: false, error: errorMessage(wrapped(hidden())) })),
    )) as { content: Array<{ text: string }> };
    expect(moved.content[0]!.text).toBe('Error: This folder holds items you cannot move.');
    const unread = (await call(
      def(async () => ({
        ok: false,
        error: `could not move: ${errorMessage(refused('no_read'))}`,
      })),
    )) as { content: Array<{ text: string }> };
    expect(unread.content[0]!.text).toBe('Error: not found');
    spy.mockRestore();
  });
});
