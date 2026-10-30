/**
 * The vault's write gateway (vault v2 part 1) on a real migrated database
 * (0346): add, replace, test, delete and import of each kind; no reply and
 * no audit row ever holds a value; a password, an SSH key or a login is
 * never opened by a read path; nothing loosens by itself. Made-up values
 * only; nothing calls a provider (the token tested here has no adapter).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run vault.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InputError } from '@mantle/std';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** A private key block of the right armour and a made-up body. */
const KEY_BLOCK = [
  '-----BEGIN ',
  'OPENSSH PRIVATE KEY-----\nnot-a-key-body\n-----END ',
  'OPENSSH PRIVATE KEY-----',
].join('');

describe.skipIf(!URL)('the vault write gateway', () => {
  let m: typeof import('@mantle/db');
  let keys: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `vault-${owner.slice(0, 8)}`;
  const who = { loginId: owner, email: `${tag}@example.invalid`, via: 'web' } as const;
  /** Every value written: none may show up in a reply or an audit row. */
  const values: string[] = [];
  const v = (s: string) => {
    const value = `test-${tag}-${s}-not-a-secret`;
    values.push(value);
    return value;
  };
  let prevMasterKey: string | undefined;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const audits = async () =>
    (await exec(sqlTag`
      select action, detail from audit_log where actor_id = ${owner} order by created_at
    `)) as unknown as { action: string; detail: Record<string, unknown> }[];
  const noValue = (x: unknown) => {
    const text = JSON.stringify(x);
    for (const value of values) expect(text).not.toContain(value);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevMasterKey = process.env.MANTLE_MASTER_KEY;
    process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    m = await import('@mantle/db');
    keys = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from audit_log where actor_id = ${owner}`);
    await exec(sqlTag`delete from api_keys where user_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
    if (prevMasterKey === undefined) delete process.env.MANTLE_MASTER_KEY;
    else process.env.MANTLE_MASTER_KEY = prevMasterKey;
  }, 60_000);

  it('adds a token by name; it reads as before, and the reply has no value', async () => {
    const value = v('token');
    const r = await keys.setVaultKey(who, owner, { ref: { name: 'weather' }, value });
    expect(r).toMatchObject({ op: 'add', secretWritten: true });
    expect(r!.key).toMatchObject({
      name: 'weather',
      kind: 'token',
      service: 'weather',
      label: 'default',
      target: [],
      needsApproval: false,
    });
    noValue(r);
    expect(await keys.getApiKey(owner, 'weather')).toEqual({ apiKey: value });
    expect((await keys.listApiKeys(owner)).find((k) => k.id === r!.key.id)?.name).toBe('weather');
  });

  it('adds a login: approval on, masked whole, and no read path opens it', async () => {
    const r = await keys.setVaultKey(who, owner, {
      ref: { name: 'pi-lab-3' },
      kind: 'login',
      value: v('login'),
      user: 'pi',
      sudoPassword: v('sudo'),
      target: ['Pi-Lab-3.lan', 'pi-lab-3.lan'],
      tags: ['Pis'],
    });
    expect(r!.key).toMatchObject({
      kind: 'login',
      target: ['pi-lab-3.lan'],
      tags: ['pis'],
      needsApproval: true,
      masked: '••••',
    });
    noValue(r);
    expect(await keys.getApiKey(owner, 'pi-lab-3')).toBeNull();
    expect(await keys.getApiKeyById(r!.key.id)).toBeNull();
    expect(await keys.resolveProviderKey(owner, 'pi-lab-3', r!.key.id)).toBeNull();
    expect((await keys.findProviderKeyIds(owner)).has('pi-lab-3')).toBe(false);
    expect(await keys.ownedKeyService(owner, r!.key.id)).toBeNull();
    // An internal token write never lands on it.
    await expect(keys.setApiKey(owner, 'pi-lab-3', 'default', v('over'))).rejects.toBeInstanceOf(
      InputError,
    );
  });

  it('a replace keeps what it does not name, and approval never goes off by itself', async () => {
    const rotated = await keys.setVaultKey(who, owner, {
      ref: { name: 'pi-lab-3' },
      value: v('login-2'),
    });
    expect(rotated).toMatchObject({ op: 'replace', secretWritten: true });
    expect(rotated!.key).toMatchObject({
      kind: 'login',
      target: ['pi-lab-3.lan'],
      needsApproval: true,
    });
    // The user is still there: the stored shape passes.
    const t = await keys.testVaultKey(who, owner, { name: 'pi-lab-3' });
    expect(t).toMatchObject({ ok: true, kind: 'login', name: 'pi-lab-3' });
    noValue(t);

    // Metadata only: no secret written.
    const tagged = await keys.setVaultKey(who, owner, { ref: { name: 'pi-lab-3' }, tags: [] });
    expect(tagged).toMatchObject({ op: 'replace', secretWritten: false });

    // A kind change needs a value; to a token it keeps approval on.
    await expect(
      keys.setVaultKey(who, owner, { ref: { name: 'pi-lab-3' }, kind: 'token' }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      keys.setVaultKey(who, owner, { ref: { name: 'pi-lab-3' }, kind: 'token', value: v('t') }),
    ).rejects.toThrow(/user belongs to/);
    const token = await keys.setVaultKey(who, owner, {
      ref: { name: 'pi-lab-3' },
      kind: 'token',
      value: v('t2'),
      user: null,
      sudoPassword: null,
    });
    expect(token!.key).toMatchObject({ kind: 'token', needsApproval: true });
    const [row] = (await exec(
      sqlTag`select fields_enc from api_keys where id = ${token!.key.id}`,
    )) as unknown as { fields_enc: Buffer | null }[];
    expect(row!.fields_enc).toBeNull();
    // Only the owner turns it off.
    const off = await keys.setVaultKey(who, owner, {
      ref: { name: 'pi-lab-3' },
      needsApproval: false,
    });
    expect(off!.key.needsApproval).toBe(false);
  });

  it('refuses a password with no target, and a reserved or bad name', async () => {
    await expect(
      keys.setVaultKey(who, owner, { ref: { name: 'db-main' }, kind: 'password', value: v('p') }),
    ).rejects.toThrow(/needs target/);
    await expect(
      keys.setVaultKey(who, owner, { ref: { name: 'mcp-site' }, value: v('m') }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      keys.setVaultKey(who, owner, { ref: { name: v('as a name') }, value: 'x' }),
    ).rejects.toSatisfy((err: Error) => !values.some((x) => err.message.includes(x)));
  });

  it('tests an SSH key by its shape and a token by its provider', async () => {
    await keys.setVaultKey(who, owner, {
      ref: { name: 'printer-07' },
      kind: 'ssh_key',
      value: KEY_BLOCK,
      user: 'pi',
      passphrase: v('pass'),
      target: ['printer-07.lan'],
      viaTailnet: true,
    });
    const ssh = await keys.testVaultKey(who, owner, { name: 'printer-07' });
    expect(ssh).toMatchObject({ ok: true, kind: 'ssh_key' });
    const token = await keys.testVaultKey(who, owner, { name: 'weather' });
    expect(token).toMatchObject({ ok: false, kind: 'token' });
    expect(token!.message).toMatch(/No adapter/);
    expect(await keys.testVaultKey(who, owner, { name: 'nothing-here' })).toBeNull();
  });

  it('imports all or nothing, naming each bad row and never its content', async () => {
    const before = (await keys.listApiKeys(owner)).length;
    const secret = v('csv-1');
    const bad = await keys.importVaultKeys(
      who,
      owner,
      [
        'name,kind,target,user,secret,tags',
        `nas-1,login,nas-1.lan,admin,${secret},storage`,
        `nas-2,lockpick,nas-2.lan,admin,${v('csv-2')},`,
        `nas-3,password,,,${v('csv-3')},`,
        `${v('csv 4')},token,,,x,`,
        `nas-1,token,,,${v('csv-5')},`,
      ].join('\n'),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.failed.map((f) => f.row)).toEqual([3, 4, 5, 6]);
    noValue(bad);
    expect((await keys.listApiKeys(owner)).length).toBe(before);

    const good = await keys.importVaultKeys(
      who,
      owner,
      [
        `nas-1,login,nas-1.lan;nas-1.local,admin,${secret},storage nas`,
        `"nas-key",ssh_key,nas-1.lan,admin,"${KEY_BLOCK}",`,
        `weather,,,,${v('csv-6')},`,
      ].join('\r\n'),
    );
    expect(good).toMatchObject({ ok: true, added: 2, replaced: 1 });
    noValue(good);
    const nas = (await keys.listApiKeys(owner)).find((k) => k.name === 'nas-1');
    expect(nas).toMatchObject({
      kind: 'login',
      target: ['nas-1.lan', 'nas-1.local'],
      tags: ['storage', 'nas'],
      needsApproval: true,
    });
  });

  it('deletes by name, and every write left an audit row with no value', async () => {
    const gone = await keys.deleteVaultKey(who, owner, { name: 'printer-07' });
    expect(gone).toMatchObject({ name: 'printer-07', kind: 'ssh_key' });
    expect(await keys.deleteVaultKey(who, owner, { name: 'printer-07' })).toBeNull();
    const rows = await audits();
    noValue(rows);
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(new Set(['vault.key.set', 'vault.key.test', 'vault.key.delete']));
    const del = rows.find((r) => r.action === 'vault.key.delete');
    expect(del!.detail).toMatchObject({ name: 'printer-07', kind: 'ssh_key', via: 'web' });
    const add = rows.find((r) => r.action === 'vault.key.set' && r.detail.name === 'pi-lab-3');
    expect(add!.detail).toMatchObject({ op: 'add', changed: ['value', 'fields'] });
  });
});
