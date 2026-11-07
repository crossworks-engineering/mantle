/**
 * The API Console's tool run is the signed-in login's own MCP call
 * (lib/dev-tools/console-tool.ts), on a real migrated Postgres through the
 * real app: Admin B's console `node_read` of Admin A's per-login file, or a
 * member's, is not found, its title and text with it; B's own per-login
 * file reads. The console's MCP bridge (it runs as the brain owner's
 * login) refuses B's call.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run console-scope.db.test
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asSuperuser,
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)("the API console runs a tool in the login's own scope", () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('@/lib/auth/tokens');
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let anchor = '';
  const tag = `console-${randomUUID().slice(0, 8)}`;
  const adminA = randomUUID();
  const adminB = randomUUID();
  const member = randomUUID();
  const file = { a: randomUUID(), member: randomUUID(), b: randomUUID() };
  let ip = 0;

  const cookieOf = (id: string) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
  const call = async (path: string, as: string, body: unknown) => {
    ip += 1;
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${ip % 250}`,
        cookie: cookieOf(as),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  const nodeRead = (as: string, id: string) =>
    call('/api/dev-tools/execute-tool', as, { slug: 'node_read', input: { id } });

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'console-scope-db-test-secret-32-chars-plus';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('@/lib/auth/tokens');
    anchor = await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync('a long enough password', 4);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${adminA}, ${`${tag}-a@example.com`}, ${hash}, 'admin'),
      (${adminB}, ${`${tag}-b@example.com`}, ${hash}, 'admin'),
      (${member}, ${`${tag}-m@example.com`}, ${hash}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    await ensureAdminUsers(sql, [adminA, adminB]);
    // The console runs a tools-table row: node_read's.
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const def = BUILTIN_TOOLS.find((t) => t.slug === 'node_read')!;
    await sql`insert into tools (owner_id, slug, name, description, input_schema, handler)
      values (${anchor}, 'node_read', ${def.name}, ${def.description},
              ${JSON.stringify(def.inputSchema)}::jsonb,
              ${JSON.stringify({ kind: 'builtin', ref: 'node_read' })}::jsonb)
      on conflict do nothing`;
    // A per-login file of each: a screenshot A attached, a member's, B's.
    for (const [id, login, name] of [
      [file.a, adminA, `${tag} a-screenshot.png`],
      [file.member, member, `${tag} member-note.png`],
      [file.b, adminB, `${tag} b-own.png`],
    ] as const) {
      await sql`
        insert into nodes (id, owner_id, type, title, path, login_id, data) values
          (${id}, ${anchor}, 'file', ${name}, 'files', ${login},
           ${JSON.stringify({ filename: name, mime: 'image/png', size_bytes: 10 })}::jsonb)`;
    }
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it("Admin B's console node_read of Admin A's or a member's per-login file: not found", async () => {
    for (const id of [file.a, file.member]) {
      const r = await nodeRead(adminB, id);
      expect(r.status, r.text).toBe(200);
      expect(JSON.parse(r.text), r.text).toMatchObject({ ok: false });
      expect(r.text).not.toContain('screenshot');
      expect(r.text).not.toContain('member-note');
    }
  });

  it("B's own per-login file reads; A reads its own", async () => {
    const own = await nodeRead(adminB, file.b);
    expect(JSON.parse(own.text), own.text).toMatchObject({ ok: true });
    expect(own.text).toContain('b-own.png');
    const a = await nodeRead(adminA, file.a);
    expect(JSON.parse(a.text), a.text).toMatchObject({ ok: true });
  });

  it("the console's MCP bridge refuses a login that is not the brain owner's", async () => {
    const r = await call('/api/dev-tools/mcp', adminB, { name: 'node_read', args: { id: file.a } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('screenshot');
  });
});
