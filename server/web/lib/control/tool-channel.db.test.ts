/**
 * The admin channel through the real app (createApp: the gate, the route
 * policies, the rate limits) on a real migrated Postgres
 * (docs/control-center.md, "The admin channel"). One database plays both
 * sides, as in control.db.test.ts: the CC rows and the box.
 *
 *  - the box: scope none (or a bad word) refuses `tool` and lists nothing;
 *    no line is `admin` (the default), which runs
 *    a settings tool through the one dispatcher and refuses a data read; a
 *    replay of the same signed body is refused; each call leaves an audit
 *    row with the tool, ok or the reason and a hash of the args only;
 *  - the CC: a call is queued with its args sealed (never plain in the row,
 *    never in a box list), taken once by the control service, sent, and
 *    answered; the answer is handed out once, then gone; a call not sent in
 *    time is answered `expired`; at most 10 wait per box.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/tool-channel.db.test.ts
 */
import { generateKeyPairSync, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  superuserClient,
} from '@mantle/db/test-support';
import { publicKeyLine, signCall } from './sign';

type Egress = (
  input: unknown,
  init?: RequestInit,
  opts?: Record<string, unknown>,
) => Promise<Response>;
const egress = vi.hoisted(() => ({ handle: null as null | Egress }));
vi.mock('@mantle/std/egress', async (orig) => ({
  ...(await orig<typeof import('@mantle/std/egress')>()),
  egressFetch: (input: unknown, init?: RequestInit, opts?: Record<string, unknown>) =>
    egress.handle!(input, init, opts),
}));

// The args are sealed with the master key (see control.db.test.ts).
vi.hoisted(() => {
  process.env.MANTLE_MASTER_KEY_NEXT ??= Buffer.alloc(32, 9).toString('base64');
});

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const BOX = 'https://brain.example.invalid';
const MARK = 'tool-arg-marker-7f3a';

describe.skipIf(!URL_)('the admin channel through the app', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let cc: typeof import('@mantle/db/control-center');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let run: typeof import('./run');
  let key: KeyObject;
  let boxId = '';
  let ip = 0;
  const sealer = async () => {
    const { seal } = await import('@mantle/crypto');
    return (plain: string, aad: string) => seal(plain, aad).ciphertext.toString('base64');
  };

  const post = (body: Buffer, headers: Record<string, string>) =>
    Promise.resolve(
      app.request('/api/control/call', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...headers,
        },
      }),
    );
  const signedBody = (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    return { body, headers: signCall(key, BOX, body) };
  };
  const signed = (obj: unknown) => {
    const s = signedBody(obj);
    return post(s.body, s.headers);
  };
  const toolCall = (name: string, args: Record<string, unknown> = {}) =>
    signed({ op: 'tool', args: { nonce: randomUUID(), name, args } });
  const auditRows = async () =>
    sql<Row[]>`select detail from audit_log
      where actor_email = 'control-center' and detail->>'op' = 'tool' order by id`;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'control-tool-db-test-secret-at-least-32';
    process.env.MANTLE_PUBLIC_URL = `${BOX}/`;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_CONTROL_CENTER_SCOPE;
    key = generateKeyPairSync('ed25519').privateKey;
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(createPublicKey(key));
    m = await import('@mantle/db');
    cc = await import('@mantle/db/control-center');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    await ensureTestAnchor(sql);
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    egress.handle = async (input, init, opts) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BOX);
      expect(opts).toMatchObject({ redirect: 'error' });
      const h = new Headers(init?.headers);
      h.set('x-forwarded-for', `203.0.113.${(ip += 1) % 250}`);
      h.set('x-forwarded-proto', 'https');
      return app.request(url.pathname, {
        method: init?.method,
        headers: h,
        body: init?.body as BodyInit,
      });
    };
  }, 120_000);

  afterAll(async () => {
    for (const k of [
      'MANTLE_CONTROL_CENTER',
      'MANTLE_CONTROL_CENTER_KEY',
      'MANTLE_CONTROL_CENTER_SCOPE',
      'MANTLE_PUBLIC_URL',
    ])
      delete process.env[k];
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('scope none, or a bad word: tool and tools are refused, nothing runs', async () => {
    process.env.MANTLE_CONTROL_CENTER_SCOPE = 'everything';
    expect(await (await toolCall('agent_list')).json()).toEqual({
      name: 'agent_list',
      ok: false,
      reason: 'scope',
    });
    process.env.MANTLE_CONTROL_CENTER_SCOPE = 'none';
    const res = await toolCall('agent_list');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'agent_list', ok: false, reason: 'scope' });
    expect(await (await signed({ op: 'tools' })).json()).toEqual({ scope: null, tools: [] });
    // The 11 old cases are as they were.
    expect(await (await signed({ op: 'hello' })).json()).toMatchObject({ ok: true });
    // A tool call without its nonce is no call of the switch.
    const bad = await signed({ op: 'tool', args: { name: 'agent_list', args: {} } });
    expect(bad.status).toBe(400);
  });

  it('admin (no line: the default): a settings tool runs through the one gate; a data read is refused; a replay too', async () => {
    delete process.env.MANTLE_CONTROL_CENTER_SCOPE;
    const list = (await (await signed({ op: 'tools' })).json()) as {
      scope: string;
      tools: { name: string }[];
    };
    expect(list.scope).toBe('admin');
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('agent_list');
    expect(names).not.toContain('file_list');
    const ok = (await (await toolCall('agent_list')).json()) as Row;
    expect(ok).toMatchObject({ name: 'agent_list', ok: true });
    expect(ok.output).toBeDefined();
    expect(await (await toolCall('file_list', { marker: MARK })).json()).toEqual({
      name: 'file_list',
      ok: false,
      reason: 'tool',
    });
    // The same signed body again, inside its 60 seconds: refused.
    const once = signedBody({
      op: 'tool',
      args: { nonce: randomUUID(), name: 'agent_list', args: {} },
    });
    expect(((await (await post(once.body, once.headers)).json()) as Row).ok).toBe(true);
    expect(await (await post(once.body, once.headers)).json()).toEqual({
      name: 'agent_list',
      ok: false,
      reason: 'replay',
    });
  });

  it('each call leaves an audit row: the tool, ok or the reason, a hash of the args only', async () => {
    let rows: Row[] = [];
    for (let i = 0; i < 60; i++) {
      rows = await auditRows();
      if (rows.length >= 5) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const details = rows.map((r) => r.detail as Row);
    expect(details.some((d) => d.tool === 'agent_list' && d.ok === true)).toBe(true);
    expect(details.some((d) => d.tool === 'file_list' && d.reason === 'tool')).toBe(true);
    expect(details.some((d) => d.reason === 'replay')).toBe(true);
    for (const d of details) expect(d.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(MARK);
  });

  it('the CC: queued sealed, taken once, answered once, then gone', async () => {
    const box = await cc.addControlBox(BOX, 'test box', 'test');
    boxId = box!.id;
    const seal = await sealer();
    const asked = await cc.askControlTools(
      { boxIds: [boxId], name: 'agent_list', args: { marker: MARK } },
      'admin@example.com',
      seal,
      0,
    );
    expect(asked.ok).toBe(true);
    const { pending } = (asked as { value: { pending: string[] } }).value;
    expect(pending).toHaveLength(1);
    // Sealed in the row; never in a box list.
    const [raw] = await sql<
      Row[]
    >`select tool_job::text as j from control_boxes where id = ${boxId}`;
    expect(String(raw!.j)).not.toContain(MARK);
    expect(String(raw!.j)).toContain('"sealed"');
    expect(JSON.stringify(await cc.listControlBoxes())).not.toMatch(/toolJob|sealed/);
    const sentBefore = (await auditRows()).length;
    // The run sends it (the box's tool refuses an argument it does not
    // know, or runs: either way it answers).
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    const [after] = await sql<Row[]>`select tool_job from control_boxes where id = ${boxId}`;
    const callRow = (after!.tool_job as { calls: Row[] }).calls[0]!;
    expect(callRow.sealed).toBeNull();
    expect(callRow.sentAt).toBeTruthy();
    expect(callRow.done).toBeTruthy();
    // A second run sends nothing more.
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    const got = await cc.askControlTools({ callIds: pending }, 'admin@example.com', seal, 0);
    const v = (got as { value: { answers: Row[]; pending: string[]; gone: string[] } }).value;
    expect(v.answers).toHaveLength(1);
    expect(v.answers[0]).toMatchObject({ id: pending[0], boxId, name: 'agent_list' });
    expect(v.answers[0]).not.toHaveProperty('sealed');
    expect(typeof v.answers[0]!.ok).toBe('boolean');
    // Handed out once: then no box holds it.
    const again = await cc.askControlTools({ callIds: pending }, 'admin@example.com', seal, 0);
    expect((again as { value: { gone: string[] } }).value.gone).toEqual(pending);
    // Only one tool call reached the box for it, over two runs.
    for (let i = 0; i < 60 && (await auditRows()).length === sentBefore; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await auditRows()).length).toBe(sentBefore + 1);
  });

  it('the tools list goes the same way, for one box at a time', async () => {
    const seal = await sealer();
    const two = await cc.askControlTools(
      { boxIds: [boxId, randomUUID()], list: true },
      'x',
      seal,
      0,
    );
    expect(two.ok).toBe(false);
    const asked = await cc.askControlTools({ boxIds: [boxId], list: true }, 'x', seal, 0);
    const id = (asked as { value: { pending: string[] } }).value.pending[0]!;
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    const got = await cc.askControlTools({ callIds: [id] }, 'x', seal, 0);
    const a = (got as { value: { answers: Row[] } }).value.answers[0]!;
    expect(a.ok).toBe(true);
    expect((a.output as { scope: string }).scope).toBe('admin');
  });

  it('not sent in time: expired, args dropped; at most 10 wait per box', async () => {
    const seal = await sealer();
    const asked = await cc.askControlTools({ boxIds: [boxId], name: 'agent_list' }, 'x', seal, 0);
    const id = (asked as { value: { pending: string[] } }).value.pending[0]!;
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    await sql`update control_boxes set tool_job = jsonb_set(tool_job, '{calls,0,at}',
      to_jsonb(${old}::text)) where id = ${boxId}`;
    await cc.expireControlToolCalls();
    const got = await cc.askControlTools({ callIds: [id] }, 'x', seal, 0);
    const a = (got as { value: { answers: Row[] } }).value.answers[0]!;
    expect(a).toMatchObject({ id, ok: false, reason: 'expired' });
    for (let i = 0; i < 10; i++) {
      expect(
        (await cc.askControlTools({ boxIds: [boxId], name: 'agent_list' }, 'x', seal, 0)).ok,
      ).toBe(true);
    }
    const full = await cc.askControlTools({ boxIds: [boxId], name: 'agent_list' }, 'x', seal, 0);
    expect(full.ok).toBe(false);
  });
});
