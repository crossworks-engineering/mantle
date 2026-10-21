/**
 * 0313: the definers that let the login write gateway send every scoped
 * statement to the write role, and the one Moderator rule of a Telegram
 * bot, on a migrated scratch brain.
 *
 *  - mantle_tg_chat_set (a Telegram chat blocked or unpaired): who may and
 *    who may not, on the write role in a login's own scope as the app sends
 *    it (session_user mantle_write_user): the chat's own login, a Moderator
 *    of its bot's workspace, an Admin user with the users area may; a user
 *    of the workspace who does not moderate it, a login in no workspace of
 *    the bot, a disabled Moderator, a Moderator of another or an archived
 *    workspace, an Admin user whose users area is off, the wrong bot and
 *    another owner answer no row and change nothing; a read-only caller,
 *    an owner that is not this brain and a login other than the scope's
 *    own are refused (42501); an action other than block or unpair is
 *    refused (22023). On the narrow role (the assistants area's route, no
 *    scope) the rule reads the login it is given.
 *  - mantle_tg_login_moderates (the bot's Moderator rule): for each case
 *    (enabled, disabled, another workspace, an archived workspace, an
 *    assistant with no workspace, an Admin user with the users area on
 *    and off) it answers as the copy loginModeratesBot held, and the
 *    moderated chats screen answers row for row as 0293's body.
 *  - The catalog: the three SECURITY DEFINER with a fixed search_path,
 *    PUBLIC revoked; EXECUTE per role as the access matrix and
 *    runtime-role.ts grant it (mantle_tg_chat_set: the write, narrow and
 *    runtime roles, not the workspace role; mantle_file_restamp_home and
 *    mantle_tg_login_moderates: the runtime role only). The restamp's rules
 *    are in packages/files/src/restamp-write-role.db.test.ts.
 *  - The renumber proof: 0313's `when` is above every `when` before it,
 *    and a database just before it applies 0313 and only it.
 *  - The rollback: rollback/<tag>.revert.sql drops the three definers,
 *    puts the SQL system-work allowlist back to 0307's body and the
 *    moderated chats screen to 0293's (md5 equal) and takes 0313 off the
 *    ledger; a roll forward applies it again.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/file-home-chat-0313.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0313_file_home_chat_definers';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);
const CHAT_SET = 'public.mantle_tg_chat_set(uuid,uuid,uuid,text,uuid)';
const RESTAMP = 'public.mantle_file_restamp_home(uuid,uuid)';
const MODERATES = 'public.mantle_tg_login_moderates(uuid,uuid,uuid)';
const MODERATED_CHATS = 'public.mantle_tg_moderated_chats(uuid,uuid)';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

const revertStatements = (): string[] =>
  readFileSync(REVERT, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

describe('0313 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and every earlier `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('the revert takes this migration off the ledger by its own `when`', () => {
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
  });
});

type Answer = {
  ok: boolean;
  code?: string;
  message?: string;
  rows?: { id: string; telegram_chat_id: string; agent_name: string | null }[];
};

describe.skipIf(!URL)('0313: mantle_tg_chat_set, who may and who may not', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<typeof postgres>;
  let w: ReturnType<typeof postgres>;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  let owner = '';
  let adminWs = '';
  const teamWs = randomUUID();
  const L = {
    admin2: randomUUID(), // an Admin user, users area on
    noUsers: randomUUID(), // an Admin user, users area off
    member: randomUUID(), // a user of Team
    mod: randomUUID(), // a Moderator of Team
    offMod: randomUUID(), // a Moderator of Team, disabled
    outsider: randomUUID(), // in no workspace of the bots
    otherMod: randomUUID(), // a Moderator of another workspace (Other)
    archMod: randomUUID(), // a Moderator of an archived workspace (Gone)
  };
  const otherWs = randomUUID();
  const archWs = randomUUID();
  const agent = { team: randomUUID(), helper: randomUUID(), arch: randomUUID() };
  const channel = { team: randomUUID(), helper: randomUUID(), arch: randomUUID() };
  const account = {
    team: randomUUID(),
    other: randomUUID(), // no channel, so no assistant
    helper: randomUUID(), // an assistant with no workspace: the Admin workspace
    arch: randomUUID(), // an assistant of the archived workspace
  };
  const tag = `tg${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    const ts: Ts = await import('./test-support');
    const viewer = await import('./viewer');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = ts.superuserClient(scratch.url, 2);
    w = ts.superuserClient(
      viewer.viewerDatabaseUrl(scratch.url, 'write', viewer.viewerRolePassword(testKey, 'write')),
    );
    owner = await ts.ensureTestAnchor(su);
    adminWs = await ts.ensureAdminUsers(su, []);
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      for (const [k, id] of Object.entries(L)) {
        await tx`insert into auth.users (id, email, password_hash, is_owner, role, disabled_at)
                 values (${id}, ${`${tag}-${k}@example.invalid`}, 'x', false,
                         ${k === 'admin2' || k === 'noUsers' ? 'admin' : 'member'},
                         ${k === 'offMod' ? new Date() : null})`;
      }
      await tx`insert into workspace_users (workspace_id, login_id, moderator, limits) values
        (${adminWs}, ${L.admin2}, true, '{}'::jsonb),
        (${adminWs}, ${L.noUsers}, true, '{"areas":{"users":false}}'::jsonb)`;
      await tx`insert into workspaces (id, owner_id, name, description, created_by)
               values (${teamWs}, ${owner}, ${`Team ${tag}`}, 'test', ${owner})`;
      await tx`insert into workspace_users (workspace_id, login_id, moderator) values
        (${teamWs}, ${L.member}, false), (${teamWs}, ${L.mod}, true),
        (${teamWs}, ${L.offMod}, true)`;
      await tx`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
               values (${agent.team}, ${owner}, ${`${tag}-team`}, 'Teamster', 'fake/model', 'p',
                       'responder', ${teamWs})`;
      await tx`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
               values (${channel.team}, ${owner}, ${agent.team}, 'telegram', ${`@${tag}`}, '\\x00')`;
      await tx`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
               values (${account.team}, ${owner}, ${`${tag}_bot`}, 'inbox.telegram_test', ${channel.team})`;
      // A bot with no channel (so no assistant, no workspace).
      await tx`insert into telegram_accounts (id, user_id, bot_username, branch_path)
               values (${account.other}, ${owner}, ${`${tag}_other_bot`}, 'inbox.telegram_test')`;
      // Other (a live workspace of no bot) and Gone (archived, its own bot),
      // each with its Moderator; a helper bot (an assistant with no
      // workspace).
      await tx`insert into workspaces (id, owner_id, name, description, created_by, archived_at)
               values (${otherWs}, ${owner}, ${`Other ${tag}`}, 'test', ${owner}, null),
                      (${archWs}, ${owner}, ${`Gone ${tag}`}, 'test', ${owner}, now())`;
      await tx`insert into workspace_users (workspace_id, login_id, moderator) values
        (${otherWs}, ${L.otherMod}, true), (${archWs}, ${L.archMod}, true)`;
      await tx`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
               values (${agent.helper}, ${owner}, ${`${tag}-helper`}, 'Helper', 'fake/model', 'p',
                       'custom', null),
                      (${agent.arch}, ${owner}, ${`${tag}-arch`}, 'Gone', 'fake/model', 'p',
                       'responder', ${archWs})`;
      await tx`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
               values (${channel.helper}, ${owner}, ${agent.helper}, 'telegram', ${`@${tag}h`}, '\\x00'),
                      (${channel.arch}, ${owner}, ${agent.arch}, 'telegram', ${`@${tag}g`}, '\\x00')`;
      await tx`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
               values (${account.helper}, ${owner}, ${`${tag}_helper_bot`}, 'inbox.telegram_test',
                       ${channel.helper}),
                      (${account.arch}, ${owner}, ${`${tag}_gone_bot`}, 'inbox.telegram_test',
                       ${channel.arch})`;
    });
  }, 240_000);

  afterAll(async () => {
    await w?.end();
    await su?.end();
    await scratch?.drop();
  });

  /** A chat on bot `acct`, allowed and paired to `login`. */
  const chatOf = async (login: string | null, acct = account.team, user = owner) => {
    const id = randomUUID();
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into telegram_chats
                 (id, account_id, user_id, telegram_chat_id, chat_type, title, username,
                  allowlist_status, login_id, pairing_code, pairing_replies)
               values (${id}, ${acct}, ${user}, ${String(Math.floor(Math.random() * 1e9))},
                       'private', 'Mia', 'mia_t', 'allowed', ${login}, 'zz0001', 2)`;
    });
    return id;
  };
  const rowOf = async (id: string) =>
    (
      await su<{ s: string; login: string | null; code: string | null; replies: number }[]>`
        select allowlist_status::text as s, login_id::text as login, pairing_code as code,
               pairing_replies as replies
          from telegram_chats where id = ${id}`
    )[0]!;
  const untouched = (login: string | null) => ({ s: 'allowed', login, code: 'zz0001', replies: 2 });

  /** The write role in `login`'s own scope (the app's write transaction:
   *  session_user mantle_write_user, the scope and actor set locally). */
  const onWriteRole = async (
    login: string,
    args: {
      login?: string;
      chat: string;
      action?: string;
      account?: string | null;
      mode?: 'rw' | 'ro';
      owner?: string;
    },
  ): Promise<Answer> => {
    try {
      const rows = await w.begin(async (tx) => {
        const [who] = await tx<{ s: string }[]>`
          select session_user::text as s,
                 set_config('mantle.actor', ${`login:rw:${login}`}, true),
                 set_config('mantle.write_mode', ${args.mode ?? 'rw'}, true),
                 set_config('mantle.ws', ${`{${adminWs},${teamWs}}`}, true),
                 set_config('mantle.mod_ws', '{}', true),
                 set_config('mantle.login_id', ${login}, true)`;
        expect(who!.s).toBe('mantle_write_user');
        return tx<NonNullable<Answer['rows']>>`
          select id::text, telegram_chat_id, agent_name
            from "public"."mantle_tg_chat_set"(${args.owner ?? owner}::uuid, ${args.login ?? login}::uuid,
                                               ${args.chat}::uuid, ${args.action ?? 'block'},
                                               ${args.account ?? null}::uuid)`;
      });
      return { ok: true, rows: [...rows] };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, code: e.code ?? '?', message: e.message ?? '' };
    }
  };

  it('the chat’s own login unpairs or blocks it', async () => {
    const id = await chatOf(L.member);
    const r = await onWriteRole(L.member, { chat: id, action: 'unpair' });
    expect(r.ok, r.message).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows![0]).toMatchObject({ id, agent_name: 'Teamster' });
    expect(await rowOf(id)).toEqual({ s: 'pending', login: null, code: null, replies: 0 });
    const id2 = await chatOf(L.member);
    expect((await onWriteRole(L.member, { chat: id2, action: 'block' })).rows).toHaveLength(1);
    expect(await rowOf(id2)).toEqual({ s: 'denied', login: null, code: null, replies: 0 });
  });

  it('a Moderator of the bot’s workspace and an Admin user with the users area may', async () => {
    for (const login of [L.mod, L.admin2, owner]) {
      const id = await chatOf(L.member);
      const r = await onWriteRole(login, { chat: id, action: 'block' });
      expect(r.rows, `${login}: ${r.message}`).toHaveLength(1);
      expect(await rowOf(id)).toMatchObject({ s: 'denied', login: null });
    }
  });

  it('anyone else answers no row and changes nothing', async () => {
    const id = await chatOf(L.member);
    for (const login of [L.outsider, L.noUsers, L.offMod]) {
      for (const action of ['block', 'unpair']) {
        const r = await onWriteRole(login, { chat: id, action });
        expect(r, login).toEqual({ ok: true, rows: [] });
      }
    }
    // A user of the workspace on someone else's chat.
    const other = await chatOf(L.mod);
    expect(await onWriteRole(L.member, { chat: other })).toEqual({ ok: true, rows: [] });
    expect(await rowOf(id)).toEqual(untouched(L.member));
    expect(await rowOf(other)).toEqual(untouched(L.mod));
  });

  it('the wrong bot, a bot with no assistant, another owner: no row', async () => {
    const id = await chatOf(L.member);
    expect(await onWriteRole(L.mod, { chat: id, account: account.other })).toEqual({
      ok: true,
      rows: [],
    });
    // A Moderator of no workspace of a bot with no assistant (an Admin
    // user with the users area still may: every bot).
    const lone = await chatOf(L.member, account.other);
    expect(await onWriteRole(L.mod, { chat: lone })).toEqual({ ok: true, rows: [] });
    expect((await onWriteRole(L.admin2, { chat: lone })).rows).toHaveLength(1);
    // The account given and right.
    expect((await onWriteRole(L.mod, { chat: id, account: account.team })).rows).toHaveLength(1);
    expect(await rowOf(lone)).toMatchObject({ s: 'denied' });
    expect(await rowOf(id)).toMatchObject({ s: 'denied' });
    // Another owner's chat id under this owner: nothing.
    const foreign = await chatOf(L.member, account.team, L.outsider);
    expect(await onWriteRole(L.member, { chat: foreign })).toEqual({ ok: true, rows: [] });
    expect(await rowOf(foreign)).toEqual(untouched(L.member));
  });

  it('a login other than the scope’s own is refused; an unknown action is refused', async () => {
    const id = await chatOf(L.member);
    const r = await onWriteRole(L.outsider, { login: L.member, chat: id });
    expect(r).toMatchObject({ ok: false, code: '42501' });
    expect(r.message).toMatch(/only the scope's own login/);
    const bad = await onWriteRole(L.member, { chat: id, action: 'allow' });
    expect(bad).toMatchObject({ ok: false, code: '22023' });
    expect(await rowOf(id)).toEqual(untouched(L.member));
  });

  it('on the narrow role with no scope the rule reads the login it is given', async () => {
    const run = async (login: string, id: string): Promise<number> =>
      su.begin(async (tx) => {
        await tx`select set_config('role', 'mantle_system_narrow', true)`;
        const [me] = await tx<{ u: string }[]>`select current_user::text as u`;
        expect(me!.u).toBe('mantle_system_narrow');
        const rows = await tx`
          select * from "public"."mantle_tg_chat_set"(${owner}::uuid, ${login}::uuid, ${id}::uuid,
                                                       'unpair', null)`;
        return rows.length;
      });
    const id = await chatOf(L.member);
    expect(await run(L.outsider, id)).toBe(0);
    expect(await rowOf(id)).toEqual(untouched(L.member));
    expect(await run(L.admin2, id)).toBe(1);
    expect(await rowOf(id)).toMatchObject({ s: 'pending', login: null });
  });

  it('a read-only caller and an owner that is not this brain are refused first', async () => {
    const id = await chatOf(L.member);
    // Read only: refused before anything else, an unknown action too.
    for (const action of ['unpair', 'block', 'allow']) {
      const r = await onWriteRole(L.member, { chat: id, action, mode: 'ro' });
      expect(r, action).toMatchObject({ ok: false, code: '42501' });
      expect(r.message).toMatch(/a read-only caller/);
    }
    // An owner that is not this brain, its own chat named: refused.
    const foreign = await chatOf(L.member, account.team, L.outsider);
    const r = await onWriteRole(L.member, { chat: foreign, owner: L.outsider });
    expect(r).toMatchObject({ ok: false, code: '42501' });
    expect(r.message).toMatch(/only on this brain/);
    // The same on the narrow role with no scope.
    const narrow = async (q: { owner: string; chat: string; mode?: string }) => {
      try {
        await su.begin(async (tx) => {
          await tx`select set_config('role', 'mantle_system_narrow', true),
                          set_config('mantle.write_mode', ${q.mode ?? ''}, true)`;
          await tx`select * from "public"."mantle_tg_chat_set"(${q.owner}::uuid, ${L.admin2}::uuid,
                                                                ${q.chat}::uuid, 'unpair', null)`;
        });
        return 'ok';
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return `${e.code}: ${e.message}`;
      }
    };
    expect(await narrow({ owner, chat: id, mode: 'ro' })).toMatch(/^42501: .*a read-only caller/);
    expect(await narrow({ owner: L.outsider, chat: foreign })).toMatch(
      /^42501: .*only on this brain/,
    );
    expect(await rowOf(id)).toEqual(untouched(L.member));
    expect(await rowOf(foreign)).toEqual(untouched(L.member));
  });

  it('the bot’s Moderator rule is one definer; each of its askers answers as its own copy did', async () => {
    // Every login against every bot: enabled, disabled, of another
    // workspace, of an archived workspace, of the Admin workspace for an
    // assistant with no workspace, an Admin user with the users area on
    // and off, a plain user, nobody, the anchor.
    const logins = { ...L, owner };
    const want: Record<string, Partial<Record<keyof typeof logins, true>>> = {
      [account.team]: { mod: true, admin2: true, owner: true },
      [account.helper]: { admin2: true, noUsers: true, owner: true },
      [account.arch]: { admin2: true, owner: true },
      [account.other]: { admin2: true, owner: true },
    };
    // A chat on every bot, so the moderated chats screen has rows to list.
    for (const acct of [account.helper, account.arch]) await chatOf(L.member, acct);
    const ddl = readFileSync(join(DIR, '0293_a6b_scope_exits.sql'), 'utf8');
    const start = ddl.indexOf('CREATE OR REPLACE FUNCTION "public"."mantle_tg_moderated_chats"');
    const old0293 = ddl
      .slice(start, ddl.indexOf('--> statement-breakpoint', start))
      .replace('"public"."mantle_tg_moderated_chats"', 'pg_temp.old_moderated_chats');
    expect(start).toBeGreaterThan(0);
    const sorted = (rows: readonly Record<string, unknown>[]) =>
      rows.map((r) => JSON.stringify(r)).sort();
    await su.begin(async (tx) => {
      await tx.unsafe(old0293);
      for (const [name, login] of Object.entries(logins)) {
        for (const acct of Object.keys(want)) {
          const [r] = await tx<{ now: boolean; ts: boolean }[]>`
            select "public"."mantle_tg_login_moderates"(${owner}::uuid, ${login}::uuid,
                                                         ${acct}::uuid) as now,
                   (exists (
                      select 1
                        from telegram_accounts t
                        join channels ch on ch.id = t.channel_id
                        join agents a on a.id = ch.agent_id and a.owner_id = ${owner}::uuid
                        join workspaces w
                          on w.id = coalesce(a.workspace_id,
                                             (select x.id from workspaces x
                                               where x.owner_id = ${owner}::uuid and x.is_admin
                                               limit 1))
                         and w.archived_at is null
                        join workspace_users u on u.workspace_id = w.id
                                              and u.login_id = ${login}::uuid and u.moderator
                        join auth.users l on l.id = u.login_id and l.disabled_at is null
                       where t.id = ${acct}::uuid)
                    or "public"."mantle_area_rule"(${login}::uuid, 'users')) as ts`;
          const expected = want[acct]![name as keyof typeof logins] === true;
          expect(r!.now, `${name} on ${acct}`).toBe(expected);
          // The copy loginModeratesBot and the first mantle_tg_chat_set held.
          expect(r!.ts, `${name} on ${acct}`).toBe(expected);
        }
        // The moderated chats screen: row for row as 0293's body answers.
        const now = await tx`select * from "public"."mantle_tg_moderated_chats"(${owner}::uuid,
                                                                               ${login}::uuid)`;
        const was =
          await tx`select * from pg_temp.old_moderated_chats(${owner}::uuid, ${login}::uuid)`;
        expect(sorted(now), name).toEqual(sorted(was));
        const bots = new Set(now.map((x) => String(x.account_id)));
        for (const acct of Object.keys(want)) {
          if (acct === account.other) continue; // no chat on it yet in every order
          expect(bots.has(acct), `${name} lists ${acct}`).toBe(
            want[acct]![name as keyof typeof logins] === true,
          );
        }
      }
    });
    // The block or unpair asks the same rule: the new cases.
    const cases: [string, typeof account.team, boolean][] = [
      [L.otherMod, account.team, false],
      [L.archMod, account.arch, false],
      [L.noUsers, account.helper, true],
      [L.mod, account.helper, false],
      [L.admin2, account.arch, true],
    ];
    for (const [login, acct, may] of cases) {
      const id = await chatOf(L.member, acct);
      const r = await onWriteRole(login, { chat: id, action: 'unpair' });
      expect(r.rows, `${login} on ${acct}: ${r.message}`).toHaveLength(may ? 1 : 0);
      expect(await rowOf(id)).toEqual(
        may ? { s: 'pending', login: null, code: null, replies: 0 } : untouched(L.member),
      );
    }
  });

  it('the catalog: definers with a fixed search_path, PUBLIC revoked, EXECUTE per role', async () => {
    const facts = await su<{ fn: string; definer: boolean; config: string[] | null }[]>`
      select p.oid::regprocedure::text as fn, p.prosecdef as definer, p.proconfig as config
        from pg_proc p
       where p.oid in (to_regprocedure(${CHAT_SET}), to_regprocedure(${RESTAMP}),
                       to_regprocedure(${MODERATES}))
       order by 1`;
    expect(facts).toHaveLength(3);
    for (const f of facts) {
      expect(f.definer, f.fn).toBe(true);
      expect(f.config, f.fn).toEqual(['search_path=public, pg_temp']);
    }
    const may = async (role: string, fn: string): Promise<boolean> =>
      (
        await su<{ a: boolean }[]>`
          select has_function_privilege(${role}, to_regprocedure(${fn}), 'EXECUTE') as a`
      )[0]!.a;
    const roles = ['public', 'mantle_view_user', 'mantle_write_user', 'mantle_system_narrow'];
    const rt = (
      await su<{ r: string | null }[]>`select to_regrole('mantle_runtime')::text as r`
    )[0]!.r;
    if (rt) roles.push('mantle_runtime');
    const want: Record<string, Record<string, boolean>> = {
      [CHAT_SET]: {
        public: false,
        mantle_view_user: false,
        mantle_write_user: true,
        mantle_system_narrow: true,
        mantle_runtime: true,
      },
      [RESTAMP]: {
        public: false,
        mantle_view_user: false,
        mantle_write_user: false,
        mantle_system_narrow: false,
        mantle_runtime: true,
      },
      // A read definer: the system pool's loginModeratesBot; the definers
      // call it as their owner.
      [MODERATES]: {
        public: false,
        mantle_view_user: false,
        mantle_write_user: false,
        mantle_system_narrow: false,
        mantle_runtime: true,
      },
    };
    for (const fn of [CHAT_SET, RESTAMP, MODERATES]) {
      for (const role of roles) expect(await may(role, fn), `${role} ${fn}`).toBe(want[fn]![role]);
    }
  });
});

describe.skipIf(!URL)('0313: the runner applies it, the revert takes it back', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });

  const present = async (): Promise<number> =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from pg_proc
         where oid in (to_regprocedure(${CHAT_SET}), to_regprocedure(${RESTAMP}),
                       to_regprocedure(${MODERATES}))`
    )[0]!.n;
  /** The md5 of each body 0313 redefines: the allowlist and the moderated
   *  chats screen. */
  const allowlistBody = async (): Promise<string> =>
    (
      await pg<{ b: string }[]>`
        select string_agg(md5(prosrc), ' ' order by oid::regprocedure::text) as b from pg_proc
         where oid in (to_regprocedure('public.mantle_ws_system_work(text)'),
                       to_regprocedure(${MODERATED_CHATS}))`
    )[0]!.b;
  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(pg, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };
  let before = '';

  beforeAll(async () => {
    const ts: Ts = await import('./test-support');
    scratch = await ts.createScratchDatabaseBefore(URL!, TAG);
    pg = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await pg`create schema if not exists "drizzle"`;
    await pg`create table if not exists "drizzle"."__drizzle_migrations" (
               id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await pg`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
               values (${mg.hash}, ${mg.folderMillis})`;
    }
    before = await allowlistBody();
  }, 300_000);

  afterAll(async () => {
    await pg?.end();
    await scratch?.drop();
  });

  it('the runner applies 0313 and only it', async () => {
    expect(await present()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(3);
    expect(await allowlistBody()).not.toBe(before);
  }, 120_000);

  it('rollback: the revert drops the three definers, puts the allowlist and the moderated chats screen back byte for byte and takes 0313 off the ledger; a roll forward applies it again', async () => {
    expect(await ledger()).toBe(1);
    const after = await allowlistBody();
    await pg.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    expect(await present()).toBe(0);
    expect(await allowlistBody()).toBe(before);
    expect(await ledger()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(3);
    expect(await allowlistBody()).toBe(after);
  }, 120_000);
});
