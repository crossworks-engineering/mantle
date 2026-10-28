/**
 * The MCP call log's row (Journal v3 J8, call-log.ts): secrets redacted,
 * the arguments and the error capped, the ids of the arguments and the
 * top-level reply, the reply's size; and the one gateway (gated-tools.ts)
 * logs each call once, refused or thrown, without changing its reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No database: each call runs as it is, with no scope entered.
vi.mock('./mcp-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpScopeEntry:
    () =>
    <T>(_writes: boolean, fn: () => Promise<T>) =>
      fn(),
  mcpAdminView: async () => null,
}));
// One builtin that marks a field sensitive without a secret_ name.
vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  return {
    ...real,
    getBuiltinRedactFields: (slug: string) =>
      slug === 'vault_pin_set' ? ['pin'] : real.getBuiltinRedactFields(slug),
  };
});

import { z } from 'zod';
import {
  mcpCallsSettled,
  setMcpCallWriter,
  startCallAudit,
  stopCallAudit,
  type GateCaller,
  type GatePolicy,
  type McpCallEntry,
} from '@mantle/db';
import {
  ARGS_MAX_BYTES,
  ERROR_MAX_BYTES,
  ITEM_IDS_MAX,
  REDACTED,
  argItemIds,
  isSecretKey,
  mcpCallEntry,
  readReply,
  redactArgs,
} from './call-log';
import { registerGatedTool, type McpGate } from './gated-tools';
import { defaultMcpGate } from './gate-policy';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const LOGIN = '55555555-5555-4555-8555-555555555555';

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

describe('redactArgs', () => {
  it('drops the value under a key that reads as a secret, at any depth', () => {
    const out = redactArgs('api_tool_create', {
      name: 'x',
      password: 'p',
      headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k', accept: 'json' },
      auth: { access_token: 't', client_secret: 's' },
      list: [{ apiKey: 'k2', id: A }],
    });
    expect(out).toEqual({
      name: 'x',
      password: REDACTED,
      headers: { Authorization: REDACTED, 'X-Api-Key': REDACTED, accept: 'json' },
      auth: { access_token: REDACTED, client_secret: REDACTED },
      list: [{ apiKey: REDACTED, id: A }],
    });
  });

  it('never keeps a value of a secret tool', () => {
    const out = redactArgs('secret_create', { name: 'k', value: 'hunter2', service: 'x' });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out).toEqual({ redacted: true, keys: ['name', 'value', 'service'] });
  });

  it('drops a field the builtin marks sensitive', () => {
    expect(redactArgs('vault_pin_set', { label: 'door', pin: '4321' })).toEqual({
      label: 'door',
      pin: REDACTED,
    });
  });

  it("a connector's secret tool keeps no value", () => {
    for (const tool of ['mcp_vault_secret_set', 'mcp_vault_get_secret']) {
      expect(JSON.stringify(redactArgs(tool, { name: 'k', value: 'hunter2' }))).not.toContain(
        'hunter2',
      );
    }
  });

  it('drops a bare `key` and the value of a header pair named as a secret', () => {
    const out = redactArgs('api_tool_create', {
      key: 'k-123',
      headers: [
        { name: 'Authorization', value: 'Basic dXNlcjpwYXNz' },
        { name: 'Accept', value: 'json' },
      ],
    });
    expect(out).toEqual({
      key: REDACTED,
      headers: [
        { name: 'Authorization', value: REDACTED },
        { name: 'Accept', value: 'json' },
      ],
    });
  });

  it('drops a token inside a string and keeps the rest of the string', () => {
    const leaks: Record<string, string> = {
      cmd: 'curl -H "Authorization: Bearer abcdefgh12345678" x',
      openai: 'use sk-proj-abcdefghijklmnop1234 here',
      github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      slack: 'xoxb-1234567890-abcdefghij',
      aws: 'AKIAABCDEFGHIJKLMNOP',
      mantle: 'mtlk_abcdefgh12345678',
      url: 'https://h.example/x?a=1&api_key=SEKRET1&sig=SEKRET2#f',
    };
    const out = redactArgs('web_fetch', leaks);
    const text = JSON.stringify(out);
    for (const secret of [
      'abcdefgh12345678',
      'abcdefghijklmnop1234',
      'abcdefghijklmnopqrstuvwxyz0123456789',
      '1234567890-abcdefghij',
      'ABCDEFGHIJKLMNOP',
      'SEKRET1',
      'SEKRET2',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(out.cmd).toBe(`curl -H "Authorization: Bearer ${REDACTED}" x`);
    expect(out.url).toBe(`https://h.example/x?a=1&api_key=${REDACTED}&sig=${REDACTED}#f`);
    expect(out.aws).toBe(`AKIA${REDACTED}`);
  });

  it('a thrown error loses its tokens too', () => {
    const e = mcpCallEntry({
      loginId: LOGIN,
      via: 'oauth',
      tool: 'web_fetch',
      args: {},
      reply: null,
      thrown: new Error('GET https://h.example/?token=SEKRET3 failed'),
      threw: true,
      durationMs: 1,
    });
    expect(e.error).toBe(`GET https://h.example/?token=${REDACTED} failed`);
  });

  it('keeps what only looks like a secret', () => {
    for (const k of [
      'secret_ref',
      'client_secret_ref',
      'clientSecretRef',
      'token_url',
      'max_tokens',
      'passage',
      'compass',
      'keywords',
      'monkey',
    ]) {
      expect(isSecretKey(k), k).toBe(false);
    }
    for (const k of ['key', 'apiKey', 'APIKey', 'X-Api-Key', 'private_key', 'pass', 'Set-Cookie']) {
      expect(isSecretKey(k), k).toBe(true);
    }
    expect(
      redactArgs('api_tool_create', {
        secret_ref: 'vault:abc',
        token_url: 'https://h.example/token',
        max_tokens: 100,
        passage: 'John 3:16',
        compass: 'north',
        note: 'the bearer of the scroll',
      }),
    ).toEqual({
      secret_ref: 'vault:abc',
      token_url: 'https://h.example/token',
      max_tokens: 100,
      passage: 'John 3:16',
      compass: 'north',
      note: 'the bearer of the scroll',
    });
  });

  it('caps the stored arguments at about 4 KB', () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) big[`k${i}`] = 'x'.repeat(400);
    const out = redactArgs('note_create', big);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(ARGS_MAX_BYTES);
    expect(out.truncated).toBe(true);
    // One long string is cut, not the whole call.
    const one = redactArgs('note_create', { body: 'y'.repeat(10_000) });
    expect(String(one.body).length).toBeLessThan(600);
  });

  it('a capped call still never carries a secret', () => {
    const big: Record<string, unknown> = { token: 'tok-secret' };
    for (let i = 0; i < 100; i++) big[`k${i}`] = 'x'.repeat(400);
    expect(JSON.stringify(redactArgs('note_create', big))).not.toContain('tok-secret');
  });
});

describe('the ids a call names', () => {
  it('reads every UUID of the arguments, never under a secret key', () => {
    expect(
      argItemIds('page_get', { id: A, ids: [B, 'nope'], nested: { folder: C }, token: WS }),
    ).toEqual([A, B, C]);
    expect(argItemIds('secret_create', { id: A })).toEqual([]);
  });

  it('reads the ids of the top-level reply and where a create landed', () => {
    const r = readReply(
      text(JSON.stringify({ id: A, results: [{ nodeId: B }], landedIn: { id: WS, name: 'W' } })),
    );
    expect(r.ok).toBe(true);
    expect(r.itemIds).toEqual(expect.arrayContaining([A, B]));
    expect(r.landedIn).toBe(WS);
    // A list reply too.
    expect(readReply(text(JSON.stringify([{ id: C }]))).itemIds).toEqual([C]);
    // Not JSON: no ids, still its size.
    expect(readReply(text('hello'))).toMatchObject({ ok: true, itemIds: [], bytes: 5 });
  });

  it('a refusal is not ok and keeps its text', () => {
    const r = readReply({ content: [{ type: 'text', text: 'Error: no' }], isError: true });
    expect(r).toMatchObject({ ok: false, error: 'Error: no', itemIds: [] });
  });

  it('keeps at most 50 ids and caps the error at about 1 KB', () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const e = mcpCallEntry({
      loginId: LOGIN,
      via: 'oauth',
      tool: 'page_get',
      args: { ids: many },
      reply: null,
      thrown: new Error('x'.repeat(5000)),
      threw: true,
      durationMs: 3,
    });
    expect(e.itemIds.length).toBeLessThanOrEqual(ITEM_IDS_MAX);
    expect(Buffer.byteLength(e.error!)).toBeLessThanOrEqual(ERROR_MAX_BYTES);
    expect(e.ok).toBe(false);
    expect(e.resultBytes).toBe(0);
  });

  it('the workspace a call names by id is its workspace', () => {
    const e = mcpCallEntry({
      loginId: LOGIN,
      via: 'key',
      tool: 'page_create',
      args: { title: 't', workspace: WS },
      reply: text(JSON.stringify({ id: A })),
      thrown: null,
      threw: false,
      durationMs: 1,
    });
    expect(e.workspaceId).toBe(WS);
    // The workspace is not an item of the call.
    expect(e.itemIds).toEqual([A]);
  });
});

describe('the one gateway logs each call once (gated-tools.ts)', () => {
  let rows: McpCallEntry[];
  beforeEach(() => {
    rows = [];
    startCallAudit({ sink: () => {} });
    setMcpCallWriter(async (e) => {
      rows.push(e);
    });
  });
  afterEach(() => {
    setMcpCallWriter(null);
    stopCallAudit();
  });
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await mcpCallsSettled();
  };

  /** A definition whose pre-run check does `check` (refuse, throw, or let
   *  it run), registered on a fake server. */
  function tool(check: () => Promise<string | null>) {
    const base = defaultMcpGate(LOGIN);
    const gate: McpGate = Object.freeze({
      ...base,
      callerFor: async (policy: GatePolicy): Promise<GateCaller> => ({
        ...(await base.callerFor(policy)),
        createHome: null,
        preRun: async () => check(),
      }),
    });
    let cb: ((a: unknown, x: unknown) => Promise<unknown>) | undefined;
    const fake = { registerTool: (_n: string, _c: unknown, h: typeof cb) => (cb = h) };
    registerGatedTool(fake as never, gate, LOGIN, {
      kind: 'definition',
      name: 'folder_rename',
      description: 'd',
      shape: { folder_id: z.string().optional(), password: z.string().optional() },
      run: async () => text(JSON.stringify({ id: B })),
    });
    return cb!;
  }

  it('a refused call: one row, not ok, the reply unchanged', async () => {
    const call = tool(async () => 'refused here');
    const res = await call({ folder_id: A, password: 'pw' }, {});
    expect(res).toEqual({
      content: [{ type: 'text', text: 'Error: refused here' }],
      isError: true,
    });
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      loginId: LOGIN,
      via: 'stdio',
      tool: 'folder_rename',
      ok: false,
      error: 'Error: refused here',
      args: { folder_id: A, password: REDACTED },
      itemIds: [A],
    });
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a call that ran: one row, ok, the ids of its reply and its size', async () => {
    const call = tool(async () => null);
    const res = await call({ folder_id: A }, {});
    expect(res).toEqual(text(JSON.stringify({ id: B })));
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, error: null, itemIds: [A, B] });
    expect(rows[0]!.resultBytes).toBe(JSON.stringify({ id: B }).length);
  });

  it('a thrown call: one row, not ok, the error still thrown', async () => {
    const call = tool(async () => {
      throw new Error('boom');
    });
    await expect(call({ folder_id: A }, {})).rejects.toThrow('boom');
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, error: 'boom', resultBytes: 0 });
  });

  it('nothing is logged in a process that writes no rows', async () => {
    stopCallAudit();
    const call = tool(async () => 'refused here');
    await call({}, {});
    await settle();
    expect(rows).toHaveLength(0);
  });
});
