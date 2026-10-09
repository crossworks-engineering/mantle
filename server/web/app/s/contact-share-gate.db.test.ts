/**
 * The /s layer of CONTACT shares on a real, migrated Postgres (contact
 * shares, migration 0214; docs/sharing.md, "Contact shares"). The routes run
 * as they are; only the app's SQLite (appDbQuery, appDbExec), the export
 * sync, the frame document, the bundle bytes and the file bytes are stood
 * in. Seeds its own brain.
 *
 *  - Gate: a forwarded link with no cookie gets the prompt (401, no title,
 *    no contact name, no menu) and serves nothing (view, bundle, bundle css,
 *    frame ticket, frame, asset, db broker, tool broker all 401); contact
 *    B's cookie on contact A's link is refused; regenerate ends an open
 *    session on the next call; switch off ends it and revokes the shares; a
 *    revoked or expired share is refused mid-session.
 *  - Code prompt: a good code sets the cookie; every failure is the same
 *    401 body; the per-address limit answers 429.
 *  - Brokers: Can write off is query only (exec 403 read-only); on, exec
 *    runs, the export sync is scheduled, app_databases.client_written_at
 *    is stamped, and the app's access log names the contact; the tool
 *    broker refuses every call and logs a 'refused' row on a contact share;
 *    a gate 401 logs a 'refused' row too, at most one per share a minute.
 *  - Embeds: a contact share of an ADMIN page serves the image the page
 *    embeds, refuses a file it does not; after a revoke, nothing.
 *  - Menu: the page of a contact share lists exactly that contact's live
 *    shares (a browser holding both contacts' cookies sees only the link's
 *    contact's items); a revoked item leaves on the next load; an open link
 *    shows no menu.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run contact-share-gate.db.test
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  execs: 0,
  queries: 0,
  synced: 0,
  frames: 0,
}));

vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/app-broker')>();
  return {
    AppSqlError: real.AppSqlError,
    AppSqlBusyError: real.AppSqlBusyError,
    appDbQuery: vi.fn(async () => {
      h.queries += 1;
      return { rows: [] };
    }),
    appDbExec: vi.fn(async () => {
      h.execs += 1;
      return { changes: 1 };
    }),
    // The real helper: the test reads app_databases.client_written_at.
    markAppClientWritten: real.markAppClientWritten,
  };
});
vi.mock('@mantle/content/app-table-exports', () => ({
  scheduleAppTableExportSync: vi.fn(() => {
    h.synced += 1;
  }),
}));
vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async () => {
    h.frames += 1;
    return new Response('<!doctype html>', { status: 200 });
  }),
}));
vi.mock('@mantle/storage', async (importOriginal) => {
  const { Readable } = await import('node:stream');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getContent: vi.fn(async () => ({ body: Readable.from(['x']), contentLength: 1 })),
  };
});
vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileById: vi.fn(async () => ({
    bytes: Buffer.from('png'),
    row: { mimeType: 'image/png', filename: 'a.png' },
  })),
}));

type Handler = (req: Request, ctx: { params: Promise<any> }) => Promise<Response>;

describe.skipIf(!URL)('contact shares through /s on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let content: typeof import('@mantle/content');
  let tokens: typeof import('@/lib/auth/tokens');
  const r: Record<string, Handler> = {};
  let shareApp: Hono;

  const owner = randomUUID();
  const tag = `csgate-${owner.slice(0, 8)}`;
  const contactA = randomUUID();
  const contactB = randomUUID();
  const page = randomUUID();
  const image = randomUUID();
  const stray = randomUUID();
  const app = randomUUID();
  const openNote = randomUUID();
  let codeA = '';
  let codeB = '';
  const tok: Record<string, string> = {};
  let ipSeq = 0;
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-10-01T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });

  const ip = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', ip());
    if (init.cookie) headers.set('cookie', init.cookie);
    return new Request(`https://brain.example.invalid${path}`, { ...init, headers });
  };
  const post = (path: string, body: unknown, cookie?: string) =>
    req(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cookie,
    });
  const p = (o: Record<string, string>) => ({ params: Promise.resolve(o) });
  const tokenOf = (path: string) => path.slice('/s/'.length);

  /** Type a code at a share's prompt; the cookie it sets (or ''). */
  const signIn = async (token: string, code: string, cookie?: string) => {
    const res = await r.code!(post(`/s/${token}/code`, { code }, cookie), p({ token }));
    const set = res.headers.get('set-cookie') ?? '';
    const m1 = /mantle_contact=([^;]*)/.exec(set);
    return {
      status: res.status,
      body: await res.json(),
      cookie: m1 ? `mantle_contact=${m1[1]}` : '',
    };
  };
  const page$ = async (token: string, cookie?: string) => {
    const res = await shareApp.request(`/s/${token}`, {
      headers: cookie ? { cookie } : {},
    });
    return { status: res.status, html: await res.text() };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'contact-share-gate-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    content = await import('@mantle/content');
    tokens = await import('@/lib/auth/tokens');
    r.code = (await import('./[token]/code/route')).POST as unknown as Handler;
    r.view = (await import('./[token]/view/route')).GET as unknown as Handler;
    r.bundle = (await import('./[token]/bundle/route')).GET as unknown as Handler;
    r.css = (await import('./[token]/bundle/css/route')).GET as unknown as Handler;
    r.ticket = (await import('./[token]/frame-ticket/route')).POST as unknown as Handler;
    r.frame = (await import('./[token]/frame/route')).GET as unknown as Handler;
    r.asset = (await import('./[token]/a/[fileId]/route')).GET as unknown as Handler;
    r.db = (await import('./[token]/db-broker/route')).POST as unknown as Handler;
    r.tool = (await import('./[token]/tool-broker/route')).POST as unknown as Handler;
    const { mountShare } = await import('@/server/pages/share');
    shareApp = new Hono();
    mountShare(shareApp);

    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    const node = (id: string, type: string, title: string, path: string, audience = 'admin') =>
      m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience)
        values (${id}, ${owner}, ${type}, ${title}, ${path}, ${audience})`);
    await node(contactA, 'contact', `${tag} Ann`, 'contacts');
    await node(contactB, 'contact', `${tag} Ben`, 'contacts');
    await node(image, 'file', `${tag} image`, 'files');
    await node(stray, 'file', `${tag} stray`, 'files');
    await node(page, 'page', `${tag} Admin page`, 'pages');
    await node(app, 'app', `${tag} Orders app`, 'apps');
    await node(openNote, 'note', `${tag} Open note`, 'notes');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'image', attrs: { nodeId: image, src: `/api/files/${image}` } },
      ],
    };
    await m.db.execute(sqlTag`
      insert into pages (node_id, doc) values (${page}, ${JSON.stringify(doc)}::jsonb)`);
    await m.db.execute(sqlTag`
      insert into apps (node_id, manifest, published_build) values (${app}, '{}'::jsonb, ${green}::jsonb)`);
    await m.db.execute(sqlTag`
      insert into app_databases (owner_id, app_node_id, storage_path) values (${owner}, ${app}, ${`apps/${app}.sqlite`})`);
    codeA = ((await content.enableContactSharing(owner, contactA)) as { code: string }).code;
    codeB = ((await content.enableContactSharing(owner, contactB)) as { code: string }).code;
    const [aPage] = await content.createContactShares(owner, page, [contactA]);
    const [aApp] = await content.createContactShares(owner, app, [contactA]);
    const [bPage] = await content.createContactShares(owner, page, [contactB]);
    tok.aPage = tokenOf(aPage!.path);
    tok.aApp = tokenOf(aApp!.path);
    tok.bPage = tokenOf(bPage!.path);
    tok.open = (await content.createShare(owner, openNote)).token;
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from app_access_log where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from share_access_log where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from app_databases where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from contact_share_codes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  beforeEach(() => {
    h.execs = 0;
    h.queries = 0;
    h.synced = 0;
    h.frames = 0;
  });

  /** The share's trail rows of one kind (the writes are fire-and-forget:
   *  wait until `done` holds). */
  type TrailRow = { detail: Record<string, unknown> };
  const trail = async (shareToken: string, kind: string, done: (rows: TrailRow[]) => boolean) => {
    let rows: TrailRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows = (await m.db.execute(sqlTag`
        select l.detail from share_access_log l join shares s on s.id = l.share_id
         where s.token = ${shareToken} and l.kind = ${kind} and l.contact_id = s.contact_id`)) as unknown as {
        detail: Record<string, unknown>;
      }[];
      if (done(rows)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    return rows;
  };

  /** Every /s route of `token` with this cookie: their statuses. */
  const everyRoute = async (token: string, cookie?: string) => {
    const t = { token };
    const frameTicket = tokens.buildAppFrameTicket({ ownerId: owner, appId: app, shareId: 'x' });
    return {
      page: (await page$(token, cookie)).status,
      view: (await r.view!(req(`/s/${token}/view`, { cookie }), p(t))).status,
      bundle: (await r.bundle!(req(`/s/${token}/bundle`, { cookie }), p(t))).status,
      css: (await r.css!(req(`/s/${token}/bundle/css`, { cookie }), p(t))).status,
      ticket: (await r.ticket!(post(`/s/${token}/frame-ticket`, {}, cookie), p(t))).status,
      frame: (
        await r.frame!(
          req(`/s/${token}/frame?t=${encodeURIComponent(frameTicket)}`, { cookie }),
          p(t),
        )
      ).status,
      asset: (await r.asset!(req(`/s/${token}/a/${image}`, { cookie }), p({ ...t, fileId: image })))
        .status,
      db: (
        await r.db!(post(`/s/${token}/db-broker`, { op: 'query', sql: 'select 1' }, cookie), p(t))
      ).status,
      tool: (await r.tool!(post(`/s/${token}/tool-broker`, { slug: 'x' }, cookie), p(t))).status,
    };
  };

  describe('the gate', () => {
    it('a forwarded link with no cookie gets the prompt and serves nothing', async () => {
      const page = await page$(tok.aPage!);
      expect(page.status).toBe(401);
      expect(page.html).toContain('data-island="contact-code"');
      expect(page.html).not.toContain('Admin page');
      expect(page.html).not.toContain('Ann');
      expect(page.html).not.toContain('Shared with you');
      for (const token of [tok.aPage!, tok.aApp!]) {
        const all = await everyRoute(token);
        expect(all, token).toEqual({
          page: 401,
          view: 401,
          bundle: 401,
          css: 401,
          ticket: 401,
          frame: 401,
          asset: 401,
          db: 401,
          tool: 401,
        });
      }
      expect(h.queries + h.execs + h.frames).toBe(0);
      // The 401s land on the share's trail, sampled: one row per share a
      // minute, though every route answered 401.
      for (const token of [tok.aPage!, tok.aApp!]) {
        await trail(token, 'refused', (rows) => rows.length >= 1);
        await new Promise((res) => setTimeout(res, 100));
        const rows = await trail(token, 'refused', () => true);
        expect(rows.map((x) => x.detail)).toEqual([{ refused: 'code-required' }]);
      }
    });

    it("contact B's cookie never opens contact A's link", async () => {
      const b = await signIn(tok.bPage!, codeB);
      expect(b.status).toBe(200);
      expect((await page$(tok.bPage!, b.cookie)).status).toBe(200);
      expect((await page$(tok.aPage!, b.cookie)).status).toBe(401);
      // B's code typed at A's link opens nothing either.
      expect((await signIn(tok.aPage!, codeB)).status).toBe(401);
    });

    it('the right code opens the link and every route of it; the other links too, with no prompt', async () => {
      const a = await signIn(tok.aPage!, codeA);
      expect(a.status).toBe(200);
      expect(a.cookie).not.toBe('');
      const pageHtml = await page$(tok.aPage!, a.cookie);
      expect(pageHtml.status).toBe(200);
      expect(pageHtml.html).toContain('Admin page');
      // The app link of the same contact opens with the same cookie.
      const res = await r.ticket!(
        post(`/s/${tok.aApp}/frame-ticket`, {}, a.cookie),
        p({ token: tok.aApp! }),
      );
      expect(res.status).toBe(200);
      const { ticket } = (await res.json()) as { ticket: string };
      expect(tokens.verifyAppFrameTicket(ticket)).toMatchObject({ contactId: contactA });
      const frame = await r.frame!(
        req(`/s/${tok.aApp}/frame?t=${encodeURIComponent(ticket)}`),
        p({ token: tok.aApp! }),
      );
      expect(frame.status).toBe(200);
    });

    it('regenerate ends an open session on the next call', async () => {
      const a = await signIn(tok.aPage!, codeA);
      expect((await page$(tok.aPage!, a.cookie)).status).toBe(200);
      const res = await r.ticket!(
        post(`/s/${tok.aApp}/frame-ticket`, {}, a.cookie),
        p({ token: tok.aApp! }),
      );
      const { ticket } = (await res.json()) as { ticket: string };
      codeA = (await content.regenerateContactCode(owner, contactA))!.code;
      expect((await page$(tok.aPage!, a.cookie)).status).toBe(401);
      // A frame ticket minted before the regenerate dies too.
      const frame = await r.frame!(
        req(`/s/${tok.aApp}/frame?t=${encodeURIComponent(ticket)}`),
        p({ token: tok.aApp! }),
      );
      expect(frame.status).toBe(401);
      // The new code opens again.
      const again = await signIn(tok.aPage!, codeA);
      expect((await page$(tok.aPage!, again.cookie)).status).toBe(200);
    });

    it('a revoked or an expired share is refused mid-session', async () => {
      const temp = randomUUID();
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path) values (${temp}, ${owner}, 'note', ${`${tag} temp`}, 'notes')`);
      const [s] = await content.createContactShares(owner, temp, [contactA]);
      const t = tokenOf(s!.path);
      const a = await signIn(t, codeA);
      expect((await page$(t, a.cookie)).status).toBe(200);
      await m.db.execute(
        sqlTag`update shares set expires_at = now() - interval '1 second' where id = ${s!.shareId}`,
      );
      expect((await page$(t, a.cookie)).status).toBe(404);
      await m.db.execute(sqlTag`update shares set expires_at = null where id = ${s!.shareId}`);
      expect((await page$(t, a.cookie)).status).toBe(200);
      await content.unshareItem(owner, s!.shareId);
      expect((await page$(t, a.cookie)).status).toBe(404);
    });
  });

  describe('the code prompt', () => {
    it('every failure is the same 401 body', async () => {
      const bodies = [
        await signIn(tok.aPage!, 'wrongcod'),
        await signIn(tok.aPage!, ''),
        await signIn('no-such-token', codeA),
        await signIn(tok.open!, codeA),
        await signIn(tok.bPage!, codeA),
      ];
      for (const b of bodies) {
        expect(b.status).toBe(401);
        expect(b.body).toEqual({ ok: false, error: 'That code was not recognised.' });
        expect(b.cookie).toBe('');
      }
    });

    it('an address gets 10 tries a minute', async () => {
      const fixed = (code: string) =>
        r.code!(
          new Request(`https://brain.example.invalid/s/${tok.aPage}/code`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.99.0.1' },
            body: JSON.stringify({ code }),
          }),
          p({ token: 'no-such-token' }),
        );
      const statuses = [];
      for (let i = 0; i < 11; i++) statuses.push((await fixed('x')).status);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe('the brokers', () => {
    it('Can write off: query only; on: the write runs, syncs, marks and is logged by contact', async () => {
      const a = await signIn(tok.aApp!, codeA);
      const exec = () =>
        r.db!(
          post(
            `/s/${tok.aApp}/db-broker`,
            { op: 'exec', sql: 'insert into t values (1)' },
            a.cookie,
          ),
          p({ token: tok.aApp! }),
        );
      const [before] = (await m.db.execute(sqlTag`
        select client_written_at as at from app_databases where app_node_id = ${app}`)) as unknown as {
        at: Date | null;
      }[];
      expect(before?.at).toBeNull();
      const off = await exec();
      expect(off.status).toBe(403);
      expect(await off.json()).toMatchObject({ reason: 'read-only' });
      expect(h.execs).toBe(0);
      const q = await r.db!(
        post(`/s/${tok.aApp}/db-broker`, { op: 'query', sql: 'select 1' }, a.cookie),
        p({ token: tok.aApp! }),
      );
      expect(q.status).toBe(200);
      expect(h.queries).toBe(1);

      const share = await content.contactSharesForNode(owner, app);
      expect(await content.setContactShareCanWrite(owner, share[0]!.shareId, true)).toBe(true);
      const on = await exec();
      expect(on.status).toBe(200);
      expect(h.execs).toBe(1);
      expect(h.synced).toBe(1);
      const [db] = (await m.db.execute(sqlTag`
        select client_written_at as at from app_databases where app_node_id = ${app}`)) as unknown as {
        at: Date | null;
      }[];
      expect(db?.at).not.toBeNull();
      let rows: Awaited<ReturnType<typeof content.listAppAccess>> = [];
      for (let i = 0; i < 100 && !rows.some((x) => x.detail.op === 'exec'); i++) {
        await new Promise((res) => setTimeout(res, 20));
        rows = await content.listAppAccess(owner, app);
      }
      expect(rows.find((x) => x.detail.op === 'exec')).toMatchObject({
        contactId: contactA,
        contactName: `${tag} Ann`,
      });
    });

    it('Informational wins over Can write: the write is refused and logged (L23)', async () => {
      const a = await signIn(tok.aApp!, codeA);
      const share = await content.contactSharesForNode(owner, app);
      expect(await content.setContactShareCanWrite(owner, share[0]!.shareId, true)).toBe(true);
      await m.db.execute(sqlTag`update apps set data_read_only = true where node_id = ${app}`);
      try {
        const res = await r.db!(
          post(
            `/s/${tok.aApp}/db-broker`,
            { op: 'exec', sql: 'insert into t values (2)' },
            a.cookie,
          ),
          p({ token: tok.aApp! }),
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ reason: 'read-only' });
        expect(h.execs).toBe(0);
        expect(h.synced).toBe(0);
        const rows = await trail(tok.aApp!, 'refused', (all) =>
          all.some((x) => x.detail.refused === 'informational'),
        );
        expect(rows.map((x) => x.detail)).toContainEqual(
          expect.objectContaining({ op: 'exec', refused: 'informational' }),
        );
        // Reads still run.
        const q = await r.db!(
          post(`/s/${tok.aApp}/db-broker`, { op: 'query', sql: 'select 1' }, a.cookie),
          p({ token: tok.aApp! }),
        );
        expect(q.status).toBe(200);
      } finally {
        await m.db.execute(sqlTag`update apps set data_read_only = false where node_id = ${app}`);
      }
    });

    it('the tool broker refuses a built-in on a contact share (only External access tools run there)', async () => {
      const a = await signIn(tok.aApp!, codeA);
      const res = await r.tool!(
        post(`/s/${tok.aApp}/tool-broker`, { slug: 'note_list' }, a.cookie),
        p({ token: tok.aApp! }),
      );
      expect(res.status).toBe(403);
      const rows = await trail(tok.aApp!, 'refused', (all) =>
        all.some((x) => x.detail.refused === 'tools'),
      );
      expect(rows.map((x) => x.detail)).toContainEqual(
        expect.objectContaining({ refused: 'tools', slug: 'note_list' }),
      );
    });
  });

  describe('embeds', () => {
    it("serves the admin page's own image, refuses a file it does not embed; after a revoke, nothing", async () => {
      const a = await signIn(tok.aPage!, codeA);
      const get = (fileId: string) =>
        r.asset!(
          req(`/s/${tok.aPage}/a/${fileId}`, { cookie: a.cookie }),
          p({ token: tok.aPage!, fileId }),
        );
      expect((await get(image)).status).toBe(200);
      expect((await get(stray)).status).toBe(404);
      const [row] = (await content.listContactSharesForAdmin(owner, contactA)).shares.filter(
        (s) => s.nodeId === page,
      );
      await content.unshareItem(owner, row!.shareId);
      expect((await get(image)).status).toBe(404);
      // Put it back for the menu tests.
      const [again] = await content.createContactShares(owner, page, [contactA]);
      tok.aPage = tokenOf(again!.path);
    });
  });

  describe('the "Shared with you" menu', () => {
    it("lists exactly the link's contact's live shares, even with both cookies", async () => {
      const a = await signIn(tok.aPage!, codeA);
      const b = await signIn(tok.bPage!, codeB, a.cookie);
      // One cookie now carries both contacts' values.
      expect(b.cookie.split('~')).toHaveLength(2);
      const aView = await page$(tok.aPage!, b.cookie);
      expect(aView.status).toBe(200);
      expect(aView.html).toContain('Shared with you (2)');
      expect(aView.html).toContain(`/s/${tok.aApp}`);
      expect(aView.html).not.toContain(`/s/${tok.bPage}`);
      const bView = await page$(tok.bPage!, b.cookie);
      expect(bView.html).toContain('Shared with you (1)');
      expect(bView.html).not.toContain(`/s/${tok.aApp}`);
    });

    it('a revoked item leaves the list on the next load', async () => {
      const a = await signIn(tok.aPage!, codeA);
      const appShare = (await content.contactSharesForNode(owner, app)).find(
        (s) => s.contactId === contactA,
      )!;
      await content.unshareItem(owner, appShare.shareId);
      const view = await page$(tok.aPage!, a.cookie);
      expect(view.html).toContain('Shared with you (1)');
      expect(view.html).not.toContain(`/s/${tok.aApp}`);
    });

    it('an open link shows no menu', async () => {
      const open = await page$(tok.open!);
      expect(open.status).toBe(200);
      expect(open.html).not.toContain('Shared with you');
      expect(open.html).not.toContain('data-contact-menu');
    });
  });
});
