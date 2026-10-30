/**
 * The vault's write gateway (vault v2 part 1) on a real migrated database
 * (0346, 0347): add, replace, test, delete and import of each kind; no
 * reply and no audit row ever holds a value; a password, an SSH key or a
 * login is never opened by a read path; nothing loosens by itself; over
 * MCP a replace or a delete waits for approval (a hold) and lands only
 * when applied as an approved call. Made-up values only; nothing calls a
 * provider (the token tested here has no adapter).
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
  /** The gateway as an area route calls it: past the gate, as bound system
   *  work (the gate refuses a caller with nothing bound, tested below). */
  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:vault', fn) as Promise<T>;
  type Keys = typeof import('./index');
  const set = (...a: Parameters<Keys['setVaultKey']>) => sys(() => keys.setVaultKey(...a));
  const test = (...a: Parameters<Keys['testVaultKey']>) => sys(() => keys.testVaultKey(...a));
  const del = (...a: Parameters<Keys['deleteVaultKey']>) => sys(() => keys.deleteVaultKey(...a));
  const imp = (...a: Parameters<Keys['importVaultKeys']>) => sys(() => keys.importVaultKeys(...a));

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

  it('refuses a caller outside every scope that is not system work (fails closed)', async () => {
    // A login's code that reached the gateway with no workspace scope: no
    // gate saw it, so the gateway's own refuses (a test runs as system work
    // by default, so the login is bound here by hand).
    await expect(
      m.runAsActor(m.loginActor(owner, 'rw'), () =>
        keys.setVaultKey(who, owner, {
          ref: { name: 'unbound' },
          kind: 'token',
          value: v('unbound'),
        }),
      ),
    ).rejects.toThrow(/only system work/);
    expect((await keys.listApiKeys(owner)).some((k) => k.name === 'unbound')).toBe(false);
  });

  it('adds a token by name; it reads as before, and the reply has no value', async () => {
    const value = v('token');
    const r = await set(who, owner, { ref: { name: 'weather' }, kind: 'token', value });
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
    const loginValue = v('login');
    const r = await set(who, owner, {
      ref: { name: 'pi-lab-3' },
      kind: 'login',
      value: loginValue,
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
    // Its value is sealed with its kind: a token's open (the row id, any
    // image's) fails; only <id>:login opens it.
    const { open } = await import('@mantle/crypto');
    const [raw] = (await exec(
      sqlTag`select key_enc from api_keys where id = ${r!.key.id}`,
    )) as unknown as { key_enc: Buffer }[];
    expect(() => open(raw!.key_enc, r!.key.id)).toThrow();
    expect(open(raw!.key_enc, keys.valueAad(r!.key.id, 'login'))).toBe(loginValue);
  });

  it('a replace keeps what it does not name, and approval never goes off by itself', async () => {
    const rotated = await set(who, owner, {
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
    const t = await test(who, owner, { name: 'pi-lab-3' });
    expect(t).toMatchObject({ ok: true, kind: 'login', name: 'pi-lab-3' });
    noValue(t);

    // Metadata only: no secret written.
    const tagged = await set(who, owner, { ref: { name: 'pi-lab-3' }, tags: [] });
    expect(tagged).toMatchObject({ op: 'replace', secretWritten: false });

    // A kind change needs a value; to a token it keeps approval on.
    await expect(
      set(who, owner, { ref: { name: 'pi-lab-3' }, kind: 'token' }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      set(who, owner, { ref: { name: 'pi-lab-3' }, kind: 'token', value: v('t') }),
    ).rejects.toThrow(/user belongs to/);
    const token = await set(who, owner, {
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
    const off = await set(who, owner, {
      ref: { name: 'pi-lab-3' },
      needsApproval: false,
    });
    expect(off!.key.needsApproval).toBe(false);
  });

  it('refuses a password with no target, an add with no kind, and a reserved or bad name', async () => {
    // A new key names its kind (never a token by default); the older Keys
    // form names a token for an add only.
    await expect(set(who, owner, { ref: { name: 'no-kind' }, value: v('nk') })).rejects.toThrow(
      /kind is required/,
    );
    const older = await set(who, owner, {
      ref: { name: 'older-form' },
      addKind: 'token',
      value: v('older'),
    });
    expect(older!.key.kind).toBe('token');
    await expect(
      set(who, owner, { ref: { name: 'db-main' }, kind: 'password', value: v('p') }),
    ).rejects.toThrow(/needs target/);
    await expect(
      set(who, owner, { ref: { name: 'mcp-site' }, value: v('m') }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(set(who, owner, { ref: { name: v('as a name') }, value: 'x' })).rejects.toSatisfy(
      (err: Error) => !values.some((x) => err.message.includes(x)),
    );
  });

  it('over MCP, widening where a key may be used needs the secret again', async () => {
    // As an approved call makes it (an MCP replace that is not one holds).
    const mcp = { loginId: owner, via: 'mcp', approval: { approver: owner } } as const;
    await set(who, owner, {
      ref: { name: 'cam-1' },
      kind: 'password',
      value: v('cam'),
      target: ['cam-1.lan'],
      tags: ['cams'],
    });
    for (const widen of [
      { target: ['cam-1.lan', 'elsewhere.example.com'] },
      { tags: ['cams', 'web'] },
      { needsApproval: false },
      { viaTailnet: true },
    ]) {
      await expect(set(mcp, owner, { ref: { name: 'cam-1' }, ...widen })).rejects.toThrow(
        /send the secret again/,
      );
    }
    // Narrowing is free; widening with the secret, or on the Keys screen, goes.
    const narrowed = await set(mcp, owner, { ref: { name: 'cam-1' }, tags: [] });
    expect(narrowed!.key.tags).toEqual([]);
    const withSecret = await set(mcp, owner, {
      ref: { name: 'cam-1' },
      value: v('cam-2'),
      target: ['cam-1.lan', 'cam-1.local'],
    });
    expect(withSecret!.key.target).toEqual(['cam-1.lan', 'cam-1.local']);
    const onScreen = await set(who, owner, { ref: { name: 'cam-1' }, needsApproval: false });
    expect(onScreen!.key.needsApproval).toBe(false);
  });

  it('a new value clears the old sudo password, so a replace cannot move it unseen', async () => {
    const mcp = { loginId: owner, via: 'mcp', approval: { approver: owner } } as const;
    const { open } = await import('@mantle/crypto');
    const fieldsOf = async (id: string) => {
      const [row] = (await exec(
        sqlTag`select fields_enc from api_keys where id = ${id}`,
      )) as unknown as { fields_enc: Buffer | null }[];
      return JSON.parse(open(row!.fields_enc!, keys.fieldsAad(id))) as Record<string, string>;
    };
    const sudo = v('box-sudo');
    const made = await set(who, owner, {
      ref: { name: 'box-9' },
      kind: 'login',
      value: v('box'),
      user: 'pi',
      sudoPassword: sudo,
      target: ['box-9.lan'],
    });
    expect(await fieldsOf(made!.key.id)).toMatchObject({ user: 'pi', sudoPassword: sudo });
    // A tag change keeps it; a new value pointed elsewhere does not.
    await set(mcp, owner, { ref: { name: 'box-9' }, tags: [] });
    expect(await fieldsOf(made!.key.id)).toMatchObject({ sudoPassword: sudo });
    const moved = await set(mcp, owner, {
      ref: { name: 'box-9' },
      value: v('box-2'),
      target: ['elsewhere.example.com'],
    });
    expect(moved!.key.target).toEqual(['elsewhere.example.com']);
    const after = await fieldsOf(made!.key.id);
    expect(after).toEqual({ user: 'pi' });
    // Sent again with the value, it stays.
    const sudo2 = v('box-sudo-2');
    await set(who, owner, { ref: { name: 'box-9' }, value: v('box-3'), sudoPassword: sudo2 });
    expect(await fieldsOf(made!.key.id)).toEqual({ user: 'pi', sudoPassword: sudo2 });
  });

  it("the older Keys form's label, spaces and all, reaches its key as before", async () => {
    const first = await set(who, owner, {
      ref: { service: 'oldform', label: 'work account' },
      addKind: 'token',
      value: v('old-1'),
    });
    expect(first!.key).toMatchObject({ name: 'oldform/work account', kind: 'token' });
    const again = await set(who, owner, {
      ref: { service: 'oldform', label: 'work account' },
      addKind: 'token',
      value: v('old-2'),
    });
    expect(again).toMatchObject({ op: 'replace', secretWritten: true });
    expect(again!.key.id).toBe(first!.key.id);
  });

  it('tests an SSH key by its shape and a token by its provider', async () => {
    await set(who, owner, {
      ref: { name: 'printer-07' },
      kind: 'ssh_key',
      value: KEY_BLOCK,
      user: 'pi',
      passphrase: v('pass'),
      target: ['printer-07.lan'],
      viaTailnet: true,
    });
    const ssh = await test(who, owner, { name: 'printer-07' });
    expect(ssh).toMatchObject({ ok: true, kind: 'ssh_key' });
    const token = await test(who, owner, { name: 'weather' });
    expect(token).toMatchObject({ ok: false, kind: 'token' });
    expect(token!.message).toMatch(/No adapter/);
    expect(await test(who, owner, { name: 'nothing-here' })).toBeNull();
  });

  it('imports all or nothing, naming each bad row and never its content', async () => {
    const before = (await keys.listApiKeys(owner)).length;
    const secret = v('csv-1');
    const bad = await imp(
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

    // An empty kind with a user is refused (never read as a token).
    const noKind = await imp(who, owner, `nas-9,,nas-9.lan,admin,${v('csv-7')},`);
    expect(noKind).toMatchObject({ ok: false, failed: [{ row: 1 }] });

    const followed: string[] = [];
    const good = await imp(
      who,
      owner,
      [
        `nas-1,login,nas-1.lan;nas-1.local,admin,${secret},storage nas`,
        `"nas-key",ssh_key,nas-1.lan,admin,"${KEY_BLOCK}",`,
        `weather,token,,,${v('csv-6')},`,
      ].join('\r\n'),
      async (w) => {
        followed.push(w.key.name);
      },
    );
    expect(good).toMatchObject({ ok: true, added: 2, replaced: 1 });
    expect(followed).toEqual(['nas-1', 'nas-key', 'weather']);
    noValue(good);
    const nas = (await keys.listApiKeys(owner)).find((k) => k.name === 'nas-1');
    expect(nas).toMatchObject({
      kind: 'login',
      target: ['nas-1.lan', 'nas-1.local'],
      tags: ['storage', 'nas'],
      needsApproval: true,
    });
  });

  it('over MCP, a replace and a delete wait for approval; only an approved call makes them', async () => {
    const mcp = { loginId: owner, via: 'mcp' } as const;
    const approved = { ...mcp, approval: { approver: owner } } as const;
    const apply = (
      a: typeof mcp | typeof approved,
      hold: string,
      asked: { id: string; shown: Record<string, unknown> }[],
    ) => sys(() => keys.applyHeldVaultWrites(a, owner, hold, asked));
    // A held change as its approved call shows it (the gateway checks it).
    const ask = (r: { key: { id: string }; held?: Record<string, unknown> }) => ({
      id: r.key.id,
      shown: r.held ?? {},
    });
    const heldOf = async (id: string) =>
      (
        (await exec(sqlTag`select held_enc from api_keys where id = ${id}`)) as unknown as {
          held_enc: Buffer | null;
        }[]
      )[0]!.held_enc;

    const first = v('held-1');
    await set(who, owner, { ref: { name: 'held-key' }, kind: 'token', value: first });
    // A new key over MCP is instant.
    const added = await set(mcp, owner, {
      ref: { name: 'held-new' },
      kind: 'token',
      value: v('held-new'),
    });
    expect(added).toMatchObject({ op: 'add', secretWritten: true });

    // A token named for a service that has one would become the key its
    // provider calls use: held on that key until approved. Another label
    // takes nothing over, so it is instant.
    const work = await set(who, owner, {
      ref: { name: 'svc-x/work' },
      kind: 'token',
      value: v('svc-work'),
    });
    const other = await set(mcp, owner, {
      ref: { name: 'svc-x/other' },
      kind: 'token',
      value: v('svc-other'),
    });
    expect(other).toMatchObject({ op: 'add' });
    const takeover = await set(mcp, owner, {
      ref: { name: 'svc-x' },
      kind: 'token',
      value: v('svc-x'),
    });
    expect(takeover).toMatchObject({
      op: 'held',
      key: { name: 'svc-x/work' },
      held: { op: 'add', name: 'svc-x', kind: 'token', changed: ['value'] },
    });
    noValue(takeover);
    expect(await keys.findProviderKeyId(owner, 'svc-x')).toBe(work!.key.id);
    const made = await apply(approved, takeover!.held!.holdId, [ask(takeover!)]);
    expect(made.keys).toMatchObject([{ op: 'add', key: { name: 'svc-x' }, secretWritten: true }]);
    expect(await heldOf(work!.key.id)).toBeNull();
    expect(await keys.findProviderKeyId(owner, 'svc-x')).toBe(made.keys[0]!.key.id);

    // A replace holds: nothing written, the reply and the row's other
    // columns carry no value.
    const second = v('held-2');
    const held = await set(mcp, owner, { ref: { name: 'held-key' }, value: second });
    expect(held).toMatchObject({ op: 'held', secretWritten: false, held: { kind: 'token' } });
    noValue(held);
    expect(await keys.getApiKey(owner, 'held-key')).toEqual({ apiKey: first });
    expect(await heldOf(held!.key.id)).not.toBeNull();
    const hold = held!.held!.holdId;

    // Another hold id opens nothing; a caller that is no approved call is refused.
    await expect(apply(approved, randomUUID(), [ask(held!)])).rejects.toThrow(keys.VAULT_HOLD_GONE);
    await expect(apply(mcp, hold, [ask(held!)])).rejects.toThrow(/approved pending call/);
    // A call that shows another change than its hold seals makes nothing:
    // the card can never say one thing while another lands.
    expect(held!.held).toMatchObject({ op: 'replace', name: 'held-key', kind: 'token' });
    for (const lie of [
      { masked: '••••' },
      { name: 'weather' },
      { op: 'delete' },
      { target: ['elsewhere.example.com'] },
    ]) {
      await expect(
        apply(approved, hold, [{ id: held!.key.id, shown: { ...held!.held, ...lie } }]),
      ).rejects.toThrow(keys.VAULT_HOLD_MISMATCH);
    }
    expect(await keys.getApiKey(owner, 'held-key')).toEqual({ apiKey: first });

    // The approval makes it, once, and clears the hold.
    const done = await apply(approved, hold, [ask(held!)]);
    expect(done.keys).toMatchObject([{ op: 'replace', secretWritten: true }]);
    noValue(done);
    expect(await keys.getApiKey(owner, 'held-key')).toEqual({ apiKey: second });
    expect(await heldOf(held!.key.id)).toBeNull();
    await expect(apply(approved, hold, [ask(held!)])).rejects.toThrow(keys.VAULT_HOLD_GONE);

    // A write to the key since the hold voids it.
    const stale = await set(mcp, owner, { ref: { name: 'held-key' }, value: v('held-3') });
    await set(who, owner, { ref: { name: 'held-key' }, tags: ['later'] });
    await expect(apply(approved, stale!.held!.holdId, [ask(stale!)])).rejects.toThrow(
      keys.VAULT_HOLD_GONE,
    );
    expect(await keys.getApiKey(owner, 'held-key')).toEqual({ apiKey: second });

    // A delete holds; a release (a rejection) drops it and it never applies.
    const d1 = await del(mcp, owner, { name: 'held-key' });
    expect(d1).toMatchObject({ key: { name: 'held-key' }, held: { kind: 'token' } });
    expect((await keys.listApiKeys(owner)).some((k) => k.name === 'held-key')).toBe(true);
    await sys(() => keys.releaseVaultHolds(owner, d1!.held!.holdId, [d1!.key.id]));
    expect(await heldOf(d1!.key.id)).toBeNull();
    await expect(apply(approved, d1!.held!.holdId, [ask(d1!)])).rejects.toThrow(
      keys.VAULT_HOLD_GONE,
    );
    // A release under another hold id leaves a hold alone.
    const d2 = await del(mcp, owner, { name: 'held-key' });
    await sys(() => keys.releaseVaultHolds(owner, randomUUID(), [d2!.key.id]));
    expect(await heldOf(d2!.key.id)).not.toBeNull();
    const gone = await apply(approved, d2!.held!.holdId, [ask(d2!)]);
    expect(gone.keys).toMatchObject([{ op: 'delete', key: { name: 'held-key' } }]);
    expect((await keys.listApiKeys(owner)).some((k) => k.name === 'held-key')).toBe(false);

    // An import adds at once and holds its replace rows under one hold.
    const imported = await imp(
      mcp,
      owner,
      [`held-new,token,,,${v('held-new-2')},`, `held-add,token,,,${v('held-add')},`].join('\n'),
    );
    expect(imported).toMatchObject({ ok: true, added: 1, replaced: 0, held: 1 });
    if (!imported.ok) return;
    noValue(imported);
    const heldRow = imported.keys.find((k) => k.op === 'held')!;
    expect(heldRow.key.name).toBe('held-new');
    expect(heldRow.held!.holdId).toBe(imported.holdId);
    const applied = await apply(approved, imported.holdId!, [ask(heldRow)]);
    expect(applied.keys).toMatchObject([{ op: 'replace', key: { name: 'held-new' } }]);
    expect(await keys.getApiKey(owner, 'held-new')).toEqual({ apiKey: values.at(-2) });

    // The audit trail: each hold, and the approved write naming its approver.
    const rows = await audits();
    noValue(rows);
    expect(rows.filter((r) => r.action === 'vault.key.hold').length).toBeGreaterThanOrEqual(5);
    const approvedSet = rows.find(
      (r) => r.action === 'vault.key.set' && r.detail.approvedBy === owner,
    );
    expect(approvedSet!.detail).toMatchObject({ name: 'held-key', via: 'mcp', op: 'replace' });
  });

  it('deletes by name, and every write left an audit row with no value', async () => {
    const gone = await del(who, owner, { name: 'printer-07' });
    expect(gone).toMatchObject({ key: { name: 'printer-07', kind: 'ssh_key' } });
    expect(await del(who, owner, { name: 'printer-07' })).toBeNull();
    const rows = await audits();
    noValue(rows);
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(
      new Set(['vault.key.set', 'vault.key.test', 'vault.key.delete', 'vault.key.hold']),
    );
    const deleted = rows.find((r) => r.action === 'vault.key.delete');
    expect(deleted!.detail).toMatchObject({ name: 'printer-07', kind: 'ssh_key', via: 'web' });
    const add = rows.find((r) => r.action === 'vault.key.set' && r.detail.name === 'pi-lab-3');
    expect(add!.detail).toMatchObject({ op: 'add', changed: ['value', 'fields'] });
  });
});
