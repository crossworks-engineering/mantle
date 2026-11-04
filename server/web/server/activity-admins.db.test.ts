/**
 * Who reads the brain's activity, on a migrated scratch database switched
 * to workspaces, through the full HTTP pipeline (runRoute): the anchor,
 * another Admin user, a Moderator and a member, each against system work
 * (a trace of no login), an anchor's heartbeat fire (no login on the
 * trace, the anchor's turn), and each login's own turn.
 *
 *  - The anchor lists and reads the system's work, its own turns and its
 *    heartbeat fires, never another login's turn.
 *  - Another Admin user (the settings area) lists and reads the system's
 *    work and its own turns; never the anchor's turns or heartbeat fires,
 *    never another login's.
 *  - An Admin user without the settings area lists its own turns only in
 *    the Activity column; /traces and the journey are refused (403).
 *  - A Moderator and a member are refused the Activity column (an owner
 *    route), /traces and the journey (the settings area's): 403 each; the
 *    read rule alone gives them their own turn only.
 *  - A member's work is the member's, whoever wrote the trace: an ingest
 *    in the member's request, a worker's run over the member's private
 *    note (stamped from the note), a chat attachment, a summary and a
 *    simulated turn of the member's chat. No Admin user, the anchor
 *    included, lists or reads it, nor the note it names.
 *  - A writer that names no login and does not mark its work the system's
 *    (a worker outside any login's work) stamps no one: a forgotten login
 *    hides the row, it never shows it to every Admin user. One marked the
 *    system's is listed to the Admin users.
 *  - A run over an item of a shared workspace (not Admin) is its maker's
 *    (the login its ingest names), else no one's, as is a run over a node
 *    that is gone: never the Admin users' system work, never the anchor's.
 *  - Rows stored before every writer stamped a login (0356): a run's trace
 *    is its run's login's (the anchor's run the anchor's), a heartbeat fire
 *    and its delegated child the anchor's (with or without a fire row), an
 *    assistant message's, a pending call's and a data-named login's trace
 *    that login's, a trace over another login's private note that login's,
 *    and one whose login cannot be told (an unclassified content row, one
 *    over a W item of unknown maker, or over a node that is gone) no one's:
 *    no reader lists it, the anchor included. A reflector's skip stays the
 *    system's, as its writer marks it now.
 *  - The stamp trigger (0269) copies a trace's login into the pending calls
 *    and tool results made under it.
 *  - The anchor's fire is a turn of no login (run_plan reads it) while its
 *    row, and its children's, name the anchor.
 *
 * Fixtures are written as the superuser on this file's own client.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/activity-admins.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the activity every Admin user reads', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let runRoute: typeof import('./run-route').runRoute;
  let raw: postgres.Sql;
  let dir = '';
  const tag = `actadm${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(), // the anchor
    admin: randomUUID(), // another user of Admin
    mod: randomUUID(), // a Moderator of W
    member: randomUUID(), // a plain user of W
    adminNs: randomUUID(), // a user of Admin with the settings area off
  };
  type Who = keyof typeof L;
  /** One trace per kind of row: the system's, the anchor's heartbeat fire,
   *  and each login's own turn. */
  const T = {
    system: randomUUID(),
    anchorFire: randomUUID(),
    owner: randomUUID(),
    admin: randomUUID(),
    mod: randomUUID(),
    member: randomUUID(),
    adminNs: randomUUID(),
  };
  type Row = keyof typeof T;
  /** What the content writers and the older rows leave, with whether the
   *  anchor and the other Admin user list and read each. */
  const N: Record<string, { id: string; owner: boolean; admin: boolean; stamp?: string }> = {};
  const SECRET = `${randomUUID().slice(0, 8)} private words`;
  /** The stamp of work no one lists (the tracing store's NO_ONE_LOGIN). */
  const NO_ONE = '00000000-0000-0000-0000-000000000000';
  let adminNote = '';
  let memberNote = '';

  const text = async (who: Who, url: string) => {
    const res = await runRoute(L[who], 'GET', url);
    return { status: res.status, body: await res.text() };
  };
  /** The rows of T a body names. */
  const named = (body: string): Row[] =>
    (Object.keys(T) as Row[]).filter((k) => body.includes(T[k])).sort();

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'activity-admins-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'activity-admins-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the activity test', { status: 503 })),
    );
    m = await import('@mantle/db');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      const admin = who === 'owner' || who === 'admin' || who === 'adminNs';
      await asSuperuser()`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${admin ? 'admin' : 'member'}, ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    const adminWs = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${L.admin}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator, limits)
      values (${adminWs}, ${L.adminNs}, true, '{"areas":{"settings":false}}'::jsonb)
      on conflict (workspace_id, login_id)
        do update set moderator = true, limits = excluded.limits`;
    const w = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${L.owner}, ${`${tag} W`}) returning id::text as id`
    )[0]!.id;
    await raw`delete from workspace_users where workspace_id = ${w}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${w}, ${L.mod}, true), (${w}, ${L.member}, false)`;
    for (const login of [L.mod, L.member]) {
      await raw`select "public"."mantle_ws_private_workspace"(
        set_config('mantle.scope_login', ${login}, true)::uuid)`;
    }

    // The anchor's heartbeat: its fire answers the anchor (answered_by
    // null) and its trace, stored before 0356, carries no login.
    const [hb] = await raw<{ id: string }[]>`
      insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                              schedule_kind, schedule, surface)
      values (${L.owner}, ${`${tag}-hb`}, 'Check', 'assistant', 'check', 'manual',
              '{"kind":"manual"}'::jsonb, '{"kind":"web"}'::jsonb)
      returning id::text as id`;
    await raw`insert into traces (id, owner_id, kind, status, login_id) values
      (${T.system}, ${L.owner}, 'federation_request', 'success', null),
      (${T.anchorFire}, ${L.owner}, 'heartbeat_fire', 'success', null),
      (${T.owner}, ${L.owner}, 'responder_turn', 'success', ${L.owner}),
      (${T.admin}, ${L.owner}, 'responder_turn', 'success', ${L.admin}),
      (${T.mod}, ${L.owner}, 'responder_turn', 'success', ${L.mod}),
      (${T.member}, ${L.owner}, 'responder_turn', 'success', ${L.member}),
      (${T.adminNs}, ${L.owner}, 'responder_turn', 'success', ${L.adminNs})`;
    await raw`insert into heartbeat_fires (heartbeat_id, trace_id, disposition, answered_by)
      values (${hb!.id}, ${T.anchorFire}, 'fired', null)`;

    // A note in Admin, and one in the member's private workspace.
    const notes = await import('@mantle/content/notes');
    const privateWs = (
      await raw<{ id: string }[]>`select workspace_id::text as id from private_workspaces
                                    where login_id = ${L.member}`
    )[0]!.id;
    const noteIn = async (ws: string, priv: string | null, title: string) => {
      const row = await m.asSystem(
        () =>
          m.withCreateHome({ createWs: ws, privateWs: priv, quiet: true }, () =>
            notes.createNote(L.owner, { title, content: `${title} body` }),
          ),
        'test',
      );
      const [home] = await raw<{ ws: string }[]>`select workspace_id::text as ws
        from item_grants where node_id = ${row.id} and is_home`;
      expect(home?.ws, `${title} is homed where it was made`).toBe(ws);
      return row.id;
    };
    adminNote = await noteIn(adminWs, null, `${tag} admin note`);
    memberNote = await noteIn(privateWs, privateWs, `${tag} ${SECRET}`);
    // Notes of the shared workspace W: one the member made (its ingest
    // names the member), one with no ingest, and one for an older row.
    const teamNote = await noteIn(w, null, `${tag} team note`);
    const teamNoIngest = await noteIn(w, null, `${tag} team note, no ingest`);
    const teamOld = await noteIn(w, null, `${tag} team note, older row`);

    // The content writers, as each runs.
    const tracing = await import('@mantle/tracing');
    const opened = (init: Parameters<typeof tracing.startTrace>[0]) =>
      tracing.startTrace(init, async () => tracing.currentTrace()!.id);
    const asMember = <R>(fn: () => Promise<R>) => m.runAsActor(m.loginActor(L.member), fn);
    const asWorker = <R>(fn: () => Promise<R>) => m.asSystem(fn, 'test');
    const subject = { subjectKind: 'node', subjectId: memberNote };
    const add = (
      key: string,
      id: string | null,
      owner: boolean,
      admin: boolean,
      stamp: string | null,
    ) => {
      expect(id, key).toBeTruthy();
      N[key] = { id: id!, owner, admin, stamp: stamp ?? 'none' };
    };
    add(
      'ingest',
      await asMember(() =>
        tracing.recordIngest({
          source: 'note_create',
          ownerId: L.owner,
          nodeId: memberNote,
          summary: `Note created: ${SECRET}`,
          snippet: SECRET,
        }),
      ),
      false,
      false,
      L.member,
    );
    add(
      'extract',
      await asWorker(() => opened({ kind: 'extractor_run', ownerId: L.owner, ...subject })),
      false,
      false,
      L.member,
    );
    add(
      'extractSkip',
      await asWorker(() =>
        tracing.recordSkippedTrace({
          kind: 'extractor_run',
          ownerId: L.owner,
          ...subject,
          disposition: 'body_too_short',
        }),
      ),
      false,
      false,
      L.member,
    );
    add(
      'attachment',
      await asMember(() => opened({ kind: 'photo_ingest', ownerId: L.owner, ...subject })),
      false,
      false,
      L.member,
    );
    add(
      'summary',
      await asWorker(() =>
        opened({
          kind: 'summarizer_run',
          ownerId: L.owner,
          subjectKind: 'chat_thread',
          subjectId: randomUUID(),
          rowLoginId: L.member,
          data: { summary: SECRET },
        }),
      ),
      false,
      false,
      L.member,
    );
    let simTurnLogin: string | null | undefined;
    const sim = await asWorker(() =>
      tracing.startTrace(
        { kind: 'manual', ownerId: L.owner, subjectKind: 'agent', rowLoginId: L.member },
        async () => {
          const child = await opened({ kind: 'manual', ownerId: L.owner });
          simTurnLogin = tracing.currentTrace()!.loginId;
          return { id: tracing.currentTrace()!.id, child };
        },
      ),
    );
    add('sim', sim.id, false, false, L.member);
    add('simChild', sim.child, false, false, L.member);
    expect(simTurnLogin, 'the turn itself names no login').toBeNull();
    let fireTurnLogin: string | null | undefined;
    const fire = await asWorker(() =>
      tracing.startTrace(
        { kind: 'heartbeat_fire', ownerId: L.owner, loginId: null, rowLoginId: L.owner },
        async () => {
          fireTurnLogin = tracing.currentTrace()!.loginId;
          const child = await opened({ kind: 'manual', ownerId: L.owner });
          return { id: tracing.currentTrace()!.id, child };
        },
      ),
    );
    add('fire', fire.id, true, false, L.owner);
    add('fireChild', fire.child, true, false, L.owner);
    expect(fireTurnLogin, 'run_plan still reads no login on the fire').toBeNull();
    // A W item's run is its maker's work, never the Admin users' system work.
    add(
      'teamIngest',
      await asMember(() =>
        tracing.recordIngest({
          source: 'note_create',
          ownerId: L.owner,
          nodeId: teamNote,
          summary: `${tag} team note`,
        }),
      ),
      false,
      false,
      L.member,
    );
    add(
      'teamExtract',
      await asWorker(() =>
        opened({
          kind: 'extractor_run',
          ownerId: L.owner,
          subjectKind: 'node',
          subjectId: teamNote,
        }),
      ),
      false,
      false,
      L.member,
    );
    add(
      'teamNoIngest',
      await asWorker(() =>
        opened({
          kind: 'extractor_run',
          ownerId: L.owner,
          subjectKind: 'node',
          subjectId: teamNoIngest,
        }),
      ),
      false,
      false,
      NO_ONE,
    );
    // A run over a node that is gone: whose it was cannot be told.
    const goneNote = await noteIn(adminWs, null, `${tag} gone note`);
    await asSuperuser()`delete from nodes where id = ${goneNote}`;
    add(
      'goneNode',
      await asWorker(() =>
        opened({
          kind: 'extractor_run',
          ownerId: L.owner,
          subjectKind: 'node',
          subjectId: goneNote,
        }),
      ),
      false,
      false,
      NO_ONE,
    );
    add(
      'system',
      await asWorker(() =>
        opened({
          kind: 'extractor_run',
          ownerId: L.owner,
          subjectKind: 'node',
          subjectId: adminNote,
        }),
      ),
      true,
      true,
      null,
    );
    // A writer that names no login, outside any login's work, and does not
    // mark its work the system's: its row is no one's, never every Admin's.
    add(
      'unnamed',
      await asWorker(() =>
        opened({ kind: 'reflector_run', ownerId: L.owner, subjectKind: 'agent_tick' }),
      ),
      false,
      false,
      NO_ONE,
    );
    add(
      'unnamedSkip',
      await asWorker(() =>
        tracing.recordSkippedTrace({
          kind: 'summarizer_run',
          ownerId: L.owner,
          subjectKind: 'agent_conversation',
          subjectId: randomUUID(),
          disposition: 'no_summarizer_worker',
        }),
      ),
      false,
      false,
      NO_ONE,
    );
    // The same skip marked the system's: listed to every Admin user.
    add(
      'systemSkip',
      await asWorker(() =>
        tracing.recordSkippedTrace({
          kind: 'reflector_run',
          ownerId: L.owner,
          subjectKind: 'agent_tick',
          system: true,
          disposition: 'no_reflector_worker',
        }),
      ),
      true,
      true,
      null,
    );

    // Rows stored before every writer stamped a login (no login at all).
    const runs = { member: randomUUID(), anchor: randomUUID() };
    const items = { member: randomUUID(), anchor: randomUUID() };
    await raw`insert into runs (id, owner_id, title, login_id) values
      (${runs.member}, ${L.owner}, 'member run', ${L.member}),
      (${runs.anchor}, ${L.owner}, 'anchor run', null)`;
    await raw`insert into run_items (id, run_id, kind) values
      (${items.member}, ${runs.member}, 'tool_call'),
      (${items.anchor}, ${runs.anchor}, 'tool_call')`;
    const old = {
      oldPrivate: {
        kind: 'extractor_run',
        sk: 'node',
        sid: memberNote,
        owner: false,
        admin: false,
      },
      oldRunMember: {
        kind: 'run_item',
        sk: 'run_item',
        sid: items.member,
        owner: false,
        admin: false,
      },
      oldRunAnchor: {
        kind: 'run_item',
        sk: 'run_item',
        sid: items.anchor,
        owner: true,
        admin: false,
      },
      oldResume: {
        kind: 'responder_turn',
        sk: 'run',
        sid: runs.member,
        owner: false,
        admin: false,
      },
      oldFireNoRow: { kind: 'heartbeat_fire', sk: null, sid: null, owner: true, admin: false },
      oldAdminNode: { kind: 'extractor_run', sk: 'node', sid: adminNote, owner: true, admin: true },
      // A worker's own skip: the system's, as its writer marks it now.
      oldReflectorSkip: {
        kind: 'reflector_run',
        sk: 'agent_tick',
        sid: null,
        owner: true,
        admin: true,
      },
    } as const;
    for (const [key, o] of Object.entries(old)) {
      const id = randomUUID();
      const status = key === 'oldReflectorSkip' ? 'skipped' : 'success';
      await raw`insert into traces (id, owner_id, kind, status, login_id, subject_kind, subject_id, data)
        values (${id}, ${L.owner}, ${o.kind}, ${status}, null, ${o.sk}, ${o.sid},
                ${raw.json({ summary: SECRET })})`;
      N[key] = { id, owner: o.owner, admin: o.admin };
    }
    // Rows that name their login only through what they point at.
    const message = randomUUID();
    const pendingCall = randomUUID();
    await raw`insert into assistant_messages (id, owner_id, direction, text, login_id)
      values (${message}, ${L.owner}, 'inbound', ${SECRET}, ${L.member})`;
    await raw`insert into pending_tool_calls (id, owner_id, tool_slug, login_id)
      values (${pendingCall}, ${L.owner}, 'note_create', ${L.member})`;
    const pointed = {
      oldMessage: { kind: 'responder_turn', sk: 'assistant_message', sid: message, data: {} },
      oldPending: { kind: 'manual', sk: 'pending_tool_call', sid: pendingCall, data: {} },
      oldDataLogin: { kind: 'summarizer_run', sk: null, sid: null, data: { login_id: L.member } },
    } as const;
    for (const [key, o] of Object.entries(pointed)) {
      const id = randomUUID();
      await raw`insert into traces (id, owner_id, kind, status, login_id, subject_kind, subject_id, data)
        values (${id}, ${L.owner}, ${o.kind}, 'success', null, ${o.sk}, ${o.sid},
                ${raw.json({ ...o.data, summary: SECRET })})`;
      N[key] = { id, owner: false, admin: false };
    }
    // What 0356 cannot place is no one's: an unclassified content row, an
    // older row over a W item whose maker is unknown, or over a node that
    // is gone. No reader lists it, the anchor included.
    for (const [key, sk, sid, owner] of [
      ['oldUnclassified', null, null, false],
      ['oldTeamItem', 'node', teamOld, false],
      ['oldGoneNode', 'node', randomUUID(), false],
    ] as const) {
      const id = randomUUID();
      await raw`insert into traces (id, owner_id, kind, status, login_id, subject_kind, subject_id, data)
        values (${id}, ${L.owner}, 'extractor_run', 'success', null, ${sk}, ${sid},
                ${raw.json({ summary: SECRET })})`;
      N[key] = { id, owner, admin: false };
    }

    const fireChild = randomUUID();
    await raw`insert into traces (id, owner_id, kind, status, login_id, data)
      values (${fireChild}, ${L.owner}, 'manual', 'success', null,
              ${raw.json({ parent_trace_id: T.anchorFire })})`;
    N.oldFireChild = { id: fireChild, owner: true, admin: false };

    // 0356 stamps the rows stored before it: run here over the older rows
    // (the scratch database ran it before they were written), twice, as a
    // re-run must change nothing.
    for (let i = 0; i < 2; i++) await run0356();
    const [child] = await raw<{ parent: string | null }[]>`
      select data ->> 'parent_trace_id' as parent from traces where id = ${fireChild}`;
    expect(child?.parent, 'the child names its parent').toBe(T.anchorFire);
  }, 240_000);

  /** Migration 0356, as the migrator runs it: one transaction. */
  const run0356 = async () => {
    const file = fileURLToPath(
      new globalThis.URL(
        '../../../packages/db/migrations/0356_trace_row_logins.sql',
        import.meta.url,
      ),
    );
    const parts = (await readFile(file, 'utf8'))
      .split('--> statement-breakpoint')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    await raw.begin(async (tx) => {
      for (const part of parts) await tx.unsafe(part);
    });
  };

  afterAll(async () => {
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** What each Admin user lists and reads. */
  const ADMIN_SEES: Record<'owner' | 'admin', Row[]> = {
    owner: ['anchorFire', 'owner', 'system'],
    admin: ['admin', 'system'],
  };

  it.each(['owner', 'admin'] as const)(
    '%s: the Activity column, the journey feed and /traces list the same rows',
    async (who) => {
      const live = await text(who, '/api/activity');
      expect(live.status, live.body).toBe(200);
      expect(named(live.body)).toEqual(ADMIN_SEES[who]);
      const feed = await text(who, '/api/debug/journey');
      expect(feed.status, feed.body).toBe(200);
      expect(named(feed.body)).toEqual(ADMIN_SEES[who]);
      const list = await text(who, '/api/traces');
      expect(list.status, list.body).toBe(200);
      expect(named(list.body)).toEqual(ADMIN_SEES[who]);
    },
  );

  it.each(['owner', 'admin'] as const)(
    '%s: one trace and one journey read exactly the rows it lists',
    async (who) => {
      for (const row of Object.keys(T) as Row[]) {
        const want = ADMIN_SEES[who].includes(row) ? 200 : 404;
        const one = await text(who, `/api/traces/${T[row]}`);
        expect(one.status, `${who} reads trace ${row}: ${one.body}`).toBe(want);
        const story = await text(who, `/api/debug/journey/${T[row]}`);
        expect(story.status, `${who} reads journey ${row}: ${story.body}`).toBe(want);
      }
    },
  );

  it.each(['mod', 'member'] as const)(
    '%s: the Activity column, /traces and the journey are refused',
    async (who) => {
      for (const url of [
        '/api/activity',
        '/api/traces',
        '/api/debug/journey',
        `/api/traces/${T.system}`,
        `/api/debug/journey/${T.system}`,
        `/api/traces/${T[who]}`,
      ]) {
        const res = await text(who, url);
        expect(res.status, `${who} ${url}: ${res.body}`).toBe(403);
      }
    },
  );

  it('an Admin user without the settings area: its own turns in the column, the rest refused', async () => {
    const live = await text('adminNs', '/api/activity');
    expect(live.status, live.body).toBe(200);
    expect(named(live.body)).toEqual(['adminNs']);
    for (const n of Object.values(N)) expect(live.body).not.toContain(n.id);
    for (const url of [
      '/api/traces',
      '/api/debug/journey',
      `/api/traces/${T.adminNs}`,
      `/api/debug/journey/${T.adminNs}`,
    ]) {
      const res = await text('adminNs', url);
      expect(res.status, `adminNs ${url}: ${res.body}`).toBe(403);
    }
  });

  it('each content writer stamps the login whose work it is', async () => {
    for (const [key, n] of Object.entries(N)) {
      if (n.stamp === undefined) continue;
      const [row] = await raw<{ l: string | null }[]>`
        select login_id::text as l from traces where id = ${n.id}`;
      expect(row?.l ?? 'none', `${key} is stamped`).toBe(n.stamp);
    }
  });

  it.each(['owner', 'admin'] as const)(
    "%s: lists and reads the system's work and its own, never a member's",
    async (who) => {
      const feed = await text(who, '/api/debug/journey');
      expect(feed.status, feed.body).toBe(200);
      const list = await text(who, '/api/traces?status=success&status=skipped&status=error');
      expect(list.status, list.body).toBe(200);
      for (const [key, n] of Object.entries(N)) {
        expect(feed.body.includes(n.id), `${who} lists ${key} in the feed`).toBe(n[who]);
        expect(list.body.includes(n.id), `${who} lists ${key} in /traces`).toBe(n[who]);
        const want = n[who] ? 200 : 404;
        const one = await text(who, `/api/traces/${n.id}`);
        expect(one.status, `${who} reads trace ${key}: ${one.body}`).toBe(want);
        const story = await text(who, `/api/debug/journey/${n.id}`);
        expect(story.status, `${who} reads journey ${key}: ${story.body}`).toBe(want);
      }
      expect(feed.body).not.toContain(SECRET);
      expect(list.body).not.toContain(SECRET);
      const landed = await text(who, `/api/debug/journey/${N.system!.id}`);
      expect(landed.body).toContain(adminNote);
      expect(landed.body).not.toContain(memberNote);
    },
  );

  it("the stamp trigger copies a trace's login into its pending calls and tool results", async () => {
    // A member's turn, the anchor's fire (its row names the anchor, its turn
    // no login), and work no one lists.
    for (const [key, trace, login] of [
      ['member', T.member, L.member],
      ['fire', N.fire!.id, L.owner],
      ['no one', N.goneNode!.id, NO_ONE],
    ] as const) {
      const call = randomUUID();
      const result = `${tag}-${randomUUID()}`;
      await raw`insert into pending_tool_calls (id, owner_id, tool_slug, trace_id)
        values (${call}, ${L.owner}, 'note_create', ${trace})`;
      await raw`insert into tool_results (id, owner_id, trace_id, tool_slug, content, bytes)
        values (${result}, ${L.owner}, ${trace}, 'note_create', 'x', 1)`;
      const [p] = await raw<{ l: string | null }[]>`
        select login_id::text as l from pending_tool_calls where id = ${call}`;
      const [r] = await raw<{ l: string | null }[]>`
        select login_id::text as l from tool_results where id = ${result}`;
      expect(p?.l, `${key}: the pending call`).toBe(login);
      expect(r?.l, `${key}: the tool result`).toBe(login);
    }
  });

  it('the read rule alone: a login without the system reads its own turn only', async () => {
    const { traceReadable } = await import('@/lib/traces');
    for (const who of ['mod', 'member'] as const) {
      const reader = { login: L[who], system: false };
      for (const row of Object.keys(T) as Row[]) {
        const readable = await m.asSystem(() => traceReadable(L.owner, T[row], reader), 'test');
        expect(readable, `${who} reads ${row}`).toBe(row === who);
      }
    }
  });
});
