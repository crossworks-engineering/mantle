/**
 * A tool that throws a database error never hands its text to the MCP client
 * (workspaces W3, defence in depth): a Postgres or drizzle error can carry
 * SQL, parameters, or with a row rule in force something about a row the
 * caller may not read. Any other error is left to the SDK, as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { addTool } from './tool-input';

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;

function registered(handler: Handler): Handler {
  let cb: Handler | undefined;
  const fake = { registerTool: (_n: string, _c: unknown, h: Handler) => (cb = h) };
  addTool(fake as never, 'search', 'd', { q: z.string() }, handler as never);
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
});
