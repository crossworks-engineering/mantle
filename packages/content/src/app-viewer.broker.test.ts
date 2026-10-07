/**
 * App identity through the real SQLite runner (docs/app-authoring-guide.md,
 * "Who is running the app"): the reserved :host_me_* parameters are filled
 * by the server from the caller's viewer, a value the browser sends for one
 * is refused, a positional value cannot land in a reserved slot, and an app
 * that uses none of them runs exactly as before. Postgres is a stand-in (one
 * registry row, one salt); the SQLite file and the runner are real.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDbExec, appDbQuery, appDbReadQuery, appViewerFor } from './app-broker';
import { appViewerPseudonym, __resetAppViewerSaltCache, type AppViewerSubject } from './app-viewer';

const SALT = 'test-salt-for-app-identity';
const OWNER = 'owner-1';
const APP = 'app-1';

const h = vi.hoisted(() => ({
  storagePath: '',
  /** Rows the next name lookup (authUsers / nodes) answers. */
  nameRows: null as Record<string, unknown>[] | null,
  saltWrites: 0,
}));

vi.mock('@mantle/db', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'app-viewer-'));
  h.storagePath = path.join(dir, 'app.sqlite');
  const registryRow = { id: 'reg-1', storagePath: h.storagePath, schemaVersion: 0 };
  return {
    db: {
      select: () => ({
        from: (t: { t?: string }) => ({
          where: () => ({
            limit: async () => (t?.t === 'names' && h.nameRows ? h.nameRows : [registryRow]),
          }),
        }),
      }),
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      update: () => ({
        set: () => ({
          where: () =>
            Object.assign(Promise.resolve(undefined), {
              returning: async () => (h.saltWrites++, [{ salt: SALT }]),
            }),
        }),
      }),
    },
    nodes: { t: 'names' },
    authUsers: { t: 'names' },
    appDatabases: {},
  };
});

const admin: AppViewerSubject = { kind: 'admin', loginId: 'login-admin', name: 'Robin' };
const member: AppViewerSubject = { kind: 'member', loginId: 'login-member', name: 'Pat' };
const client: AppViewerSubject = { kind: 'client', loginId: 'login-client', name: 'Casey' };
const contact: AppViewerSubject = { kind: 'contact', contactId: 'contact-7', name: 'Ann' };
const pub: AppViewerSubject = { kind: 'public' };

const WHO = 'SELECT :host_me_id AS id, :host_me_name AS name, :host_me_kind AS kind';

beforeAll(async () => {
  await appDbExec(
    OWNER,
    APP,
    'CREATE TABLE IF NOT EXISTS log (who_id TEXT, who_name TEXT, who_kind TEXT, what TEXT)',
  );
});
beforeEach(() => {
  h.nameRows = null;
  __resetAppViewerSaltCache();
});

describe('the server fills :host_me_* on every kind of viewer', () => {
  const cases: [AppViewerSubject, Record<string, unknown>][] = [
    [admin, { id: appViewerPseudonym(SALT, 'login:login-admin'), name: 'Robin', kind: 'admin' }],
    [member, { id: appViewerPseudonym(SALT, 'login:login-member'), name: 'Pat', kind: 'member' }],
    [client, { id: appViewerPseudonym(SALT, 'login:login-client'), name: 'Casey', kind: 'client' }],
    [contact, { id: appViewerPseudonym(SALT, 'contact:contact-7'), name: 'Ann', kind: 'contact' }],
    [pub, { id: null, name: null, kind: 'public' }],
  ];

  for (const [viewer, want] of cases) {
    it(`${viewer.kind}: a query reads the viewer, and no email field exists`, async () => {
      const rows = await appDbQuery(OWNER, APP, WHO, [], undefined, { viewer });
      expect(rows).toEqual([want]);
      expect(Object.keys(rows[0]!)).toEqual(['id', 'name', 'kind']);
    });
  }

  it('a write records who did it, next to the app’s own positional values', async () => {
    await appDbExec(
      OWNER,
      APP,
      'INSERT INTO log (who_id, who_name, who_kind, what) VALUES (:host_me_id, :host_me_name, :host_me_kind, ?)',
      ['approved'],
      undefined,
      { viewer: member },
    );
    const rows = await appDbQuery(OWNER, APP, "SELECT * FROM log WHERE what = 'approved'");
    expect(rows).toEqual([
      {
        who_id: appViewerPseudonym(SALT, 'login:login-member'),
        who_name: 'Pat',
        who_kind: 'member',
        what: 'approved',
      },
    ]);
  });

  it('merges with the app’s own named values, and the @ and $ forms work', async () => {
    const rows = await appDbQuery(
      OWNER,
      APP,
      'SELECT :mine AS mine, @host_me_kind AS k, $host_me_name AS n, ? AS p',
      [{ mine: 'x' }, 'pos'],
      undefined,
      { viewer: client },
    );
    expect(rows).toEqual([{ mine: 'x', k: 'client', n: 'Casey', p: 'pos' }]);
  });

  it('the same person keeps one id per app, and the salt is provisioned once', async () => {
    const a = await appDbQuery(OWNER, APP, 'SELECT :host_me_id AS id', [], undefined, {
      viewer: member,
    });
    const b = await appDbQuery(OWNER, APP, 'SELECT :host_me_id AS id', [], undefined, {
      viewer: { ...member, kind: 'admin' },
    });
    expect(a).toEqual(b);
    const before = h.saltWrites;
    await appDbQuery(OWNER, APP, 'SELECT :host_me_id AS id', [], undefined, { viewer: member });
    expect(h.saltWrites).toBe(before);
  });
});

describe('the browser cannot fake who', () => {
  for (const key of ['host_me_id', ':host_me_id', '@host_me_name', '$HOST_ME_KIND', 'Host_Me_x']) {
    it(`refuses a sent value named ${key}`, async () => {
      await expect(
        appDbExec(
          OWNER,
          APP,
          'INSERT INTO log (who_id, what) VALUES (:host_me_id, ?)',
          [{ [key]: 'forged' }, 'x'],
          undefined,
          { viewer: member },
        ),
      ).rejects.toThrow(/filled by the host/);
    });
  }

  it('refuses a sent reserved value even when the SQL does not use it', async () => {
    await expect(
      appDbQuery(OWNER, APP, 'SELECT :a AS a', [{ a: 1, host_me_id: 'forged' }], undefined, {
        viewer: member,
      }),
    ).rejects.toThrow(/filled by the host/);
  });

  it('a positional value never lands in a reserved slot', async () => {
    const rows = await appDbQuery(
      OWNER,
      APP,
      'SELECT :host_me_id AS id, ? AS p',
      ['forged'],
      undefined,
      {
        viewer: member,
      },
    );
    expect(rows).toEqual([{ id: appViewerPseudonym(SALT, 'login:login-member'), p: 'forged' }]);
    // ?1 shares the named slot's index, and a positional value cannot bind it.
    await expect(
      appDbQuery(OWNER, APP, 'SELECT :host_me_id AS id, ?1 AS p', ['forged'], undefined, {
        viewer: member,
      }),
    ).rejects.toThrow();
  });

  it('refuses an unknown reserved name, such as an email, in any case', async () => {
    for (const sql of ['SELECT :host_me_email AS e', 'SELECT :HOST_ME_ID AS i']) {
      await expect(appDbQuery(OWNER, APP, sql, [], undefined, { viewer: member })).rejects.toThrow(
        /unknown reserved parameter/,
      );
    }
  });

  it('a caller that names no person cannot use them (fails closed)', async () => {
    await expect(appDbQuery(OWNER, APP, WHO)).rejects.toThrow(/only when a person runs the app/);
    await expect(
      appDbExec(OWNER, APP, 'INSERT INTO log (who_id) VALUES (:host_me_id)'),
    ).rejects.toThrow(/only when a person runs the app/);
    await expect(appDbReadQuery(OWNER, APP, WHO)).rejects.toThrow(
      /only when a person runs the app/,
    );
    await expect(
      appDbReadQuery(OWNER, APP, 'SELECT :a AS a', [{ host_me_id: 'forged' }]),
    ).rejects.toThrow(/filled by the host/);
  });
});

describe('an app that does not use them is unaffected', () => {
  it('positional and its own named parameters run as before, with or without a viewer', async () => {
    for (const opts of [{}, { viewer: member }]) {
      expect(
        await appDbQuery(OWNER, APP, 'SELECT ? AS a, ? AS b', [1, 'two'], undefined, opts),
      ).toEqual([{ a: 1, b: 'two' }]);
      expect(await appDbQuery(OWNER, APP, 'SELECT :x AS x', [{ x: 5 }], undefined, opts)).toEqual([
        { x: 5 },
      ]);
    }
  });

  it('the text in a string literal or comment is not a parameter', async () => {
    expect(await appDbQuery(OWNER, APP, "SELECT ':host_me_id' AS s -- :host_me_email\n")).toEqual([
      { s: ':host_me_id' },
    ]);
  });

  it('never provisions a salt for SQL without them', async () => {
    const before = h.saltWrites;
    await appDbQuery(OWNER, APP, 'SELECT 1 AS one', [], undefined, { viewer: member });
    expect(h.saltWrites).toBe(before);
  });
});

describe('appViewerFor (what host.me() answers in the frame)', () => {
  it('looks up a login display name when the frame has only the id, never an email', async () => {
    h.nameRows = [{ displayName: '  Pat  ' }];
    expect(await appViewerFor(OWNER, APP, { kind: 'member', loginId: 'login-member' })).toEqual({
      id: appViewerPseudonym(SALT, 'login:login-member'),
      name: 'Pat',
      kind: 'member',
    });
    h.nameRows = [{ displayName: null }];
    expect(await appViewerFor(OWNER, APP, { kind: 'client', loginId: 'login-client' })).toEqual({
      id: appViewerPseudonym(SALT, 'login:login-client'),
      name: null,
      kind: 'client',
    });
  });

  it("looks up a contact's name", async () => {
    h.nameRows = [{ title: 'Ann' }];
    expect(await appViewerFor(OWNER, APP, { kind: 'contact', contactId: 'contact-7' })).toEqual({
      id: appViewerPseudonym(SALT, 'contact:contact-7'),
      name: 'Ann',
      kind: 'contact',
    });
  });

  it('an open link is nobody', async () => {
    expect(await appViewerFor(OWNER, APP, { kind: 'public' })).toEqual({
      id: null,
      name: null,
      kind: 'public',
    });
  });
});

describe('appViewerPseudonym', () => {
  it('is stable, per app, per person, and does not carry the raw id', () => {
    const a = appViewerPseudonym('salt-a', 'login:L1');
    expect(a).toBe(appViewerPseudonym('salt-a', 'login:L1'));
    expect(a).not.toBe(appViewerPseudonym('salt-b', 'login:L1'));
    expect(a).not.toBe(appViewerPseudonym('salt-a', 'login:L2'));
    expect(a).not.toBe(appViewerPseudonym('salt-a', 'contact:L1'));
    expect(a).toMatch(/^u_[A-Za-z0-9_-]{22}$/);
    expect(a).not.toContain('L1');
  });
});
