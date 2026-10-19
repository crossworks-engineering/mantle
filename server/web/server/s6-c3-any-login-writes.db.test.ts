/**
 * Admin users' any-login writes enter the login's scope, part c3 (plan
 * v3.2 S6): anyLoginScope (session.ts) no longer sends an Admin user's
 * write on an any-login row to the system pool with no scope. The rows
 * moved: POST /api/access-keys, DELETE /api/access-keys/:id, the chat
 * writes (POST /api/assistant/turn, read, threads, threads/:id/continue,
 * threads/:id/summarize, transcribe) and the Telegram pairing writes (POST
 * /api/telegram/pair, chats/:id/block, chats/:id/unpair, DELETE
 * my-chats/:id). On a migrated scratch database, in warn and in on (the
 * actor and the edit check together, as on the fleet), through the full
 * HTTP pipeline (runRoute):
 *
 *  - the Admin-only branch of a key revoke (another login's key) is the
 *    definer's (mantle_access_key_revoke, 0293 and 0306), now called in the
 *    Admin user's scope on the write role: an Admin user revokes a
 *    member's key (with the keys area or without: today's rule is "an
 *    Admin user"); a role drift login and a member do not (404, the key
 *    stays live);
 *  - a key make keeps its order of answers (the risky tools 400 before the
 *    password 403);
 *  - a chat write naming an assistant of a workspace the Admin user is not
 *    in answers "no agent" (404) as on main, where the scope would let it
 *    fall through to the default agent (resolveChatAgentToWrite); an
 *    unknown slug answers 404 too (narrower: main fell through);
 *  - member-negative: a member reaches only its own workspace's assistant;
 *  - wider, safe (the CEO's call, named in the handover): a chat write with
 *    no slug, where the default pick is another workspace's assistant the
 *    Admin user is not in, answered "no agent" on main (the system pool
 *    found that row first); in the scope the pick is the Admin assistant
 *    (200). No data the caller could not read; the reads worked so already;
 *  - an Admin user with the users area blocks and unpairs another login's
 *    chat of another workspace's bot in its scope; one without it does not;
 *  - a turn with an upload saves the file in the Admin workspace (home).
 *
 * The Telegram pairing writes are proved per role in w7d-telegram.db.test.ts
 * (their rules are the 'login-telegram' exit's, unchanged); the guard
 * sweep (a4-guard-sweep.test.ts) records that the 12 rows now enter the
 * scope (out=user) with every answer byte-equal.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/s6-c3-any-login-writes.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

// A turn enqueues its DBOS workflow (the scratch database has no DBOS
// system database): a stand-in that takes the job, as w7c-chat does.
vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async () => ({
      getResult: async () => {
        const at = new Date('2030-01-03T00:00:00.000Z');
        return {
          inbound: { id: 'in', text: 'read this', createdAt: at },
          outbound: { id: 'out', text: 'ok', createdAt: at },
          reply: 'ok',
          artifacts: [],
        };
      },
    }),
    getWorkflow: async () => ({ input: [] }),
  }),
}));

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;

type Mode = 'warn' | 'on';

describe.skipIf(!DB_URL)("S6 c3: an Admin user's any-login writes in the login's scope", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `s6c3${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    admin: randomUUID(),
    /** An Admin user with the keys and users areas off. */
    limited: randomUUID(),
    member: randomUUID(),
    /** Role admin, no seat in the Admin workspace (role drift). */
    drift: randomUUID(),
  };
  const ws = { admin: '', other: '' };
  const AG = { admin: randomUUID(), other: randomUUID() };
  const slug = { admin: `${tag}-admin`, other: `${tag}-other` };
  const recorded: string[] = [];
  const TG = {
    agent: randomUUID(),
    channel: randomUUID(),
    account: randomUUID(),
    chat: randomUUID(),
  };

  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  const call = async (name: string, who: string, method: string, url: string, body?: unknown) => {
    const res = await runRoute(who, method, url, body);
    const text = await res.text();
    recorded.push(`${name}: ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    expect(text, name).not.toMatch(RAW);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON: the status says it
    }
    return { status: res.status, text, json };
  };

  /** A live key of `login`, made as a row (no password needed). */
  const keyOf = async (login: string): Promise<string> =>
    (
      await raw<
        { id: string }[]
      >`insert into access_keys (name, login_id, key_prefix, key_hash, access)
        values (${`${tag} key`}, ${login}, ${randomUUID().replace(/-/g, '').slice(0, 8)},
                ${createHash('sha256').update(randomUUID()).digest('hex')}, 'read')
        returning id::text as id`
    )[0]!.id;

  const keyRow = async (id: string) =>
    (
      await raw<{ revoked: boolean; by: string | null }[]>`
        select revoked_at is not null as revoked, revoked_by::text as by
          from access_keys where id = ${id}`
    )[0]!;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 's6-c3-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 's6-c3-any-login-writes-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the S6 c3 test', { status: 503 })),
    );
    m = await import('@mantle/db');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      const role = who === 'member' ? 'member' : 'admin';
      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'}, ${role},
                ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    ws.other = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${L.owner}, ${`${tag} other`}) returning id::text as id`
    )[0]!.id;
    await raw`delete from workspace_users where workspace_id = ${ws.other}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.other}, ${L.member}, true)`;
    for (const id of [L.admin, L.limited]) {
      await raw`insert into workspace_users (workspace_id, login_id, moderator, limits)
        values (${ws.admin}, ${id}, true,
                ${raw.json(id === L.limited ? { areas: { users: false, keys: false } } : {})})
        on conflict (workspace_id, login_id)
        do update set moderator = true, limits = excluded.limits`;
    }
    await raw`delete from workspace_users where login_id = ${L.drift}`;
    // The Admin workspace's assistant and the other workspace's (a resource
    // each), as the chat routes find them.
    for (const [k, wid] of [
      ['admin', ws.admin],
      ['other', ws.other],
    ] as const) {
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, workspace_id)
        values (${AG[k]}, ${L.owner}, ${slug[k]}, ${`${k} assistant`}, 'test/model', 'p', ${wid})`;
    }
    await raw`delete from workspace_resources where type = 'assistant'
                and workspace_id in (${ws.admin}, ${ws.other})`;
    await raw`insert into workspace_resources (workspace_id, type, ref_id) values
      (${ws.admin}, 'assistant', ${AG.admin}), (${ws.other}, 'assistant', ${AG.other})`;
    // Another workspace's bot (a responder, its channel and account) with a
    // member's allowed chat: the Telegram moderation cells.
    await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${TG.agent}, ${L.owner}, ${`${tag}-bot`}, 'bot', 'test/model', 'p', 'responder',
              ${ws.other})`;
    await raw`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
      values (${TG.channel}, ${L.owner}, ${TG.agent}, 'telegram', ${`@${tag}_bot`}, '\\x00')`;
    await raw`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
      values (${TG.account}, ${L.owner}, ${`${tag}_bot`}, 'inbox.telegram_test', ${TG.channel})`;
    await raw`insert into telegram_chats
        (id, account_id, user_id, telegram_chat_id, chat_type, title, allowlist_status, login_id)
      values (${TG.chat}, ${TG.account}, ${L.owner}, '9001', 'private', 'Chat', 'allowed',
              ${L.member})`;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['S6 c3 any-login writes, each answer:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: an Admin user revokes another login's key; a member and role drift do not`, async () => {
      await setMode(mode);
      for (const who of ['admin', 'limited'] as const) {
        const k = await keyOf(L.member);
        const res = await call(
          `${mode} ${who} revokes a member's key`,
          L[who],
          'DELETE',
          `/api/access-keys/${k}`,
        );
        expect(res.status, res.text).toBe(200);
        expect(res.json).toEqual({ ok: true });
        expect(await keyRow(k)).toEqual({ revoked: true, by: L[who] });
      }
      for (const [who, owner] of [
        ['drift', L.member],
        ['member', L.admin],
      ] as const) {
        const k = await keyOf(owner);
        const res = await call(
          `${mode} ${who} revokes another's key`,
          L[who],
          'DELETE',
          `/api/access-keys/${k}`,
        );
        expect(res.status, res.text).toBe(404);
        expect(res.json).toEqual({ error: 'not found' });
        expect(await keyRow(k)).toEqual({ revoked: false, by: null });
      }
      // Its own key: every login.
      for (const who of ['admin', 'drift', 'member'] as const) {
        const k = await keyOf(L[who]);
        const res = await call(
          `${mode} ${who} revokes its own key`,
          L[who],
          'DELETE',
          `/api/access-keys/${k}`,
        );
        expect(res.status, res.text).toBe(200);
        expect(await keyRow(k)).toEqual({ revoked: true, by: L[who] });
      }
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });

    it(`${mode}: a key make answers in today's order`, async () => {
      await setMode(mode);
      const risky = await call(
        `${mode} limited risky tools`,
        L.limited,
        'POST',
        '/api/access-keys',
        {
          name: 'k',
          access: 'read',
          areas: null,
          riskyTools: ['task_delete'],
          password: 'wrong',
        },
      );
      expect(risky.status, risky.text).toBe(400);
      expect(risky.json.reason).toBe('risky-tools');
      for (const who of ['admin', 'limited', 'member'] as const) {
        const res = await call(
          `${mode} ${who} wrong password`,
          L[who],
          'POST',
          '/api/access-keys',
          {
            name: 'k',
            access: 'read',
            areas: null,
            password: 'wrong',
          },
        );
        expect(res.status, res.text).toBe(403);
        expect(res.json.reason).toBe('password');
      }
    });

    it(`${mode}: a chat write names only an assistant the login may chat with`, async () => {
      await setMode(mode);
      const at = '2030-01-01T00:00:00.000Z';
      for (const who of ['admin', 'limited'] as const) {
        const own = await call(
          `${mode} ${who} read admin agent`,
          L[who],
          'POST',
          '/api/assistant/read',
          { agentSlug: slug.admin, at },
        );
        expect(own.status, own.text).toBe(200);
        expect(own.json).toEqual({ ok: true, agentSlug: slug.admin, lastReadAt: at });
        const dflt = await call(
          `${mode} ${who} read default`,
          L[who],
          'POST',
          '/api/assistant/read',
          { at },
        );
        expect(dflt.status, dflt.text).toBe(200);
        // Another workspace's assistant: "no agent", as on main (where the
        // system pool found its row and refused it); an unknown slug too.
        for (const s of [slug.other, `${tag}-nobody`]) {
          const res = await call(
            `${mode} ${who} read ${s}`,
            L[who],
            'POST',
            '/api/assistant/read',
            { agentSlug: s, at },
          );
          expect(res.status, res.text).toBe(404);
          expect(res.json).toEqual({ error: 'no_agent' });
          const arch = await call(
            `${mode} ${who} archive ${s}`,
            L[who],
            'POST',
            '/api/assistant/threads',
            { agent: s },
          );
          expect(arch.status, arch.text).toBe(404);
          expect(arch.json).toEqual({ error: 'no chat agent' });
        }
      }
      // No Admin user's cursor on the other workspace's assistant.
      const cursors = await raw<{ login: string }[]>`
        select login_id::text as login from assistant_read_cursors
         where agent_id = ${AG.other} and login_id in (${L.admin}, ${L.limited})`;
      expect(cursors).toEqual([]);
      // Member-negative: its own workspace's assistant only.
      const mine = await call(
        `${mode} member read other`,
        L.member,
        'POST',
        '/api/assistant/read',
        { agentSlug: slug.other, at },
      );
      expect(mine.status, mine.text).toBe(200);
      const admins = await call(
        `${mode} member read admin`,
        L.member,
        'POST',
        '/api/assistant/read',
        { agentSlug: slug.admin, at },
      );
      expect(admins.status, admins.text).toBe(404);
      expect(admins.json).toEqual({ error: 'no_agent' });
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });

    it(`${mode}: wider, safe: no slug and the default pick is another workspace's assistant`, async () => {
      await setMode(mode);
      const at = '2030-01-02T00:00:00.000Z';
      // The other workspace's assistant is every login's default pick by
      // priority. On main an Admin user's write found it on the system
      // pool and answered "no agent" (404); in the scope the Admin user does
      // not read it, so the pick is the Admin assistant.
      await raw`update agents set priority = 1000 where id = ${AG.other}`;
      try {
        for (const who of ['admin', 'limited'] as const) {
          const res = await call(
            `${mode} ${who} read no slug, other default`,
            L[who],
            'POST',
            '/api/assistant/read',
            { at },
          );
          expect(res.status, res.text).toBe(200);
          expect(res.json.ok).toBe(true);
          expect(res.json.agentSlug).toBe(slug.admin);
        }
        const cursors = await raw<{ login: string }[]>`
          select login_id::text as login from assistant_read_cursors
           where agent_id = ${AG.other} and login_id in (${L.admin}, ${L.limited})`;
        expect(cursors).toEqual([]);
      } finally {
        await raw`update agents set priority = 0 where id = ${AG.other}`;
      }
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });

    it(`${mode}: an Admin user with the users area blocks and unpairs another login's chat`, async () => {
      await setMode(mode);
      const chat = async () =>
        (
          await raw<{ s: string; login: string | null }[]>`
            select allowlist_status::text as s, login_id::text as login
              from telegram_chats where id = ${TG.chat}`
        )[0]!;
      const allow = async () =>
        raw`update telegram_chats set allowlist_status = 'allowed', login_id = ${L.member},
              pairing_code = null where id = ${TG.chat}`;
      for (const action of ['block', 'unpair'] as const) {
        await allow();
        // Without the users area (and no seat in the bot's workspace): no.
        const no = await call(
          `${mode} limited ${action} member's chat`,
          L.limited,
          'POST',
          `/api/telegram/chats/${TG.chat}/${action}`,
        );
        expect(no.status, no.text).toBe(404);
        expect(await chat()).toEqual({ s: 'allowed', login: L.member });
        const yes = await call(
          `${mode} admin ${action} member's chat`,
          L.admin,
          'POST',
          `/api/telegram/chats/${TG.chat}/${action}`,
        );
        expect(yes.status, yes.text).toBe(200);
        expect(await chat()).toEqual({
          s: action === 'block' ? 'denied' : 'pending',
          login: null,
        });
      }
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });

    it(`${mode}: a turn with an upload saves the file in the Admin workspace`, async () => {
      await setMode(mode);
      const name = `${tag}-${mode}-upload.txt`;
      const boundary = `----${tag}`;
      const form = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="text"',
        '',
        'read this',
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${name}"`,
        'Content-Type: text/plain',
        '',
        'a note for the upload cell',
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const res = await runRoute(L.admin, 'POST', '/api/assistant/turn', undefined, {
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        rawBody: form,
      });
      const text = await res.text();
      recorded.push(`${mode} admin turn with upload: ${res.status} ${text.slice(0, 160)}`);
      expect(text).not.toMatch(RAW);
      expect(res.status, text).toBe(200);
      // A file's home is on its own row (nodes.home_ws, as landedIn reads
      // it), not a workspace_resources row; the route names the file
      // `<epoch>-<safe base>.<ext>` and its title is that name.
      const homes = await raw<{ ws: string }[]>`
        select n.home_ws::text as ws from nodes n
         where n.owner_id = ${L.owner} and n.type = 'file'
           and n.title like ${`%${tag}-${mode}-upload%`}`;
      expect(homes.length, JSON.stringify(homes)).toBeGreaterThan(0);
      expect(new Set(homes.map((h) => h.ws))).toEqual(new Set([ws.admin]));
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });
  }
});
