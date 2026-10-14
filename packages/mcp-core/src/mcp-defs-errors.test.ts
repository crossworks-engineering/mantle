/**
 * The four responder definitions never reply a database error's own text
 * (A5 step 4 re-audit, LOW-D): ask_responder, ask_as_responder,
 * responder_turn_input and responder_turn_record catch what the runtime
 * throws and reply it. A database error (its message carries the SQL and
 * its params) is the one mapper's words (thrownToolDatabaseError), as
 * folder_rename's and file_rename's are since step 4 fix round 1; any other
 * error keeps its text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/runtime/assistant', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  describeResponderPersona: vi.fn(),
  describeResponderTurnInput: vi.fn(),
  recordMcpResponderTurn: vi.fn(),
  runSimulatedResponderTurn: vi.fn(),
}));

import {
  describeResponderPersona,
  describeResponderTurnInput,
  recordMcpResponderTurn,
  runSimulatedResponderTurn,
} from '@mantle/runtime/assistant';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { mcpDefinition } from './mcp-defs';
import type { McpRegisterContext } from './register/context';

type Reply = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** The body a definition registers, bound to a stdio connection. */
function bodyOf(slug: string): (args: Record<string, unknown>) => Promise<Reply> {
  let body: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  const ctx = {
    ownerId: 'o1',
    loginId: 'l1',
    transport: 'stdio',
    jsonReply: (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] }),
    registerDefinition: (
      _slug: string,
      _description: string,
      _shape: unknown,
      fn: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      body = fn;
    },
  } as unknown as McpRegisterContext;
  mcpDefinition(slug)!.register(ctx);
  return body! as (args: Record<string, unknown>) => Promise<Reply>;
}

/** A Drizzle query error over a lock timeout, shaped as drizzle-orm throws it. */
function drizzleLockTimeout(): Error {
  const cause = Object.assign(new Error('canceling statement due to lock timeout'), {
    code: '55P03',
    severity: 'ERROR',
  });
  return Object.assign(
    new Error('Failed query: select "id" from "agents" where "slug" = $1\nparams: secret-slug'),
    { name: 'DrizzleQueryError', cause },
  );
}

const CASES: Array<[string, () => ReturnType<typeof vi.fn>, Record<string, unknown>]> = [
  ['ask_responder', () => vi.mocked(runSimulatedResponderTurn), { message: 'hi' }],
  ['ask_as_responder', () => vi.mocked(describeResponderPersona), {}],
  ['responder_turn_input', () => vi.mocked(describeResponderTurnInput), { message: 'hi' }],
  [
    'responder_turn_record',
    () => vi.mocked(recordMcpResponderTurn),
    { message: 'hi', reply: 'hello', model: 'm' },
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the responder definitions mask a database error (LOW-D)', () => {
  it.each(CASES)('%s replies the one mapper words, never the SQL', async (slug, fn, args) => {
    fn().mockRejectedValue(drizzleLockTimeout());
    const reply = await bodyOf(slug)(args);
    expect(reply).toEqual({
      content: [{ type: 'text', text: `${slug} failed: ${DATABASE_ERROR_PUBLIC}` }],
      isError: true,
    });
  });

  it.each(CASES)(
    '%s keeps the text of an error that is not the database',
    async (slug, fn, args) => {
      fn().mockRejectedValue(new Error('no responder agent named x'));
      const reply = await bodyOf(slug)(args);
      expect(reply).toEqual({
        content: [{ type: 'text', text: `${slug} failed: no responder agent named x` }],
        isError: true,
      });
    },
  );
});
