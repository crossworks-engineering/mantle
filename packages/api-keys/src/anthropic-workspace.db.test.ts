/**
 * An Anthropic key's workspace id, against a real database (0292): stored
 * with the key, returned on every lookup in the key's credential (the handle
 * the adapters send from), cleared the same way, and refused on any other
 * service or in any shape but ASCII letters, digits, `_` and `-` (the app
 * and the table check agree). Two rows holding the same key value keep their
 * own ids. Placeholder key strings only; nothing calls Anthropic.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run anthropic-workspace.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InputError } from '@mantle/std';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('an Anthropic key carries its workspace id', () => {
  let m: typeof import('@mantle/db');
  let keys: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `anthropic-ws-${owner.slice(0, 8)}`;
  let prevMasterKey: string | undefined;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  /** The Keys screen's workspace id change: the vault gateway's set by id. */
  const setWorkspace = async (o: string, id: string, ws: string | null) => {
    const r = await keys.setVaultKey({ loginId: null, via: 'web' }, o, {
      ref: { id },
      anthropicWorkspaceId: ws,
    });
    return r && { anthropicWorkspaceId: r.key.anthropicWorkspaceId };
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
    await exec(sqlTag`delete from api_keys where user_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
    if (prevMasterKey === undefined) delete process.env.MANTLE_MASTER_KEY;
    else process.env.MANTLE_MASTER_KEY = prevMasterKey;
  }, 60_000);

  it('stores it with the key and returns it in the credential of every lookup', async () => {
    const plaintext = `test-ant-${tag}-a`;
    const row = await keys.setApiKey(owner, 'anthropic', 'ws', plaintext, {
      anthropicWorkspaceId: '  wrkspc_test_one  ',
    });
    expect(row.anthropicWorkspaceId).toBe('wrkspc_test_one');
    const credential = { apiKey: plaintext, anthropicWorkspaceId: 'wrkspc_test_one' };
    expect(await keys.getApiKeyById(row.id)).toEqual(credential);
    expect(await keys.getApiKey(owner, 'anthropic', 'ws')).toEqual(credential);
    expect(await keys.resolveProviderKey(owner, 'anthropic')).toEqual(credential);

    const listed = (await keys.listApiKeys(owner)).find((k) => k.id === row.id);
    expect(listed?.anthropicWorkspaceId).toBe('wrkspc_test_one');
  });

  it('keeps it on a re-save that does not name it, and clears it when asked', async () => {
    const plaintext = `test-ant-${tag}-b`;
    const row = await keys.setApiKey(owner, 'anthropic', 'ws', plaintext);
    expect(row.anthropicWorkspaceId).toBe('wrkspc_test_one');

    const cleared = await setWorkspace(owner, row.id, '  ');
    expect(cleared?.anthropicWorkspaceId).toBeNull();
    expect(await keys.getApiKeyById(row.id)).toEqual({ apiKey: plaintext });

    const set = await setWorkspace(owner, row.id, 'wrkspc_test_two');
    expect(set?.anthropicWorkspaceId).toBe('wrkspc_test_two');
    expect(await keys.getApiKeyById(row.id)).toEqual({
      apiKey: plaintext,
      anthropicWorkspaceId: 'wrkspc_test_two',
    });
  });

  it("two rows holding the same key value each return their own row's id", async () => {
    const same = `test-ant-${tag}-same`;
    const a = await keys.setApiKey(owner, 'anthropic', 'same-a', same, {
      anthropicWorkspaceId: 'wrkspc_row_a',
    });
    const b = await keys.setApiKey(owner, 'anthropic', 'same-b', same, {
      anthropicWorkspaceId: 'wrkspc_row_b',
    });
    const none = await keys.setApiKey(owner, 'anthropic', 'same-none', same);
    // Opened in every order: the row opened last never decides another's id.
    for (const order of [
      [a, b, none],
      [none, b, a],
      [b, none, a],
    ]) {
      const got = [];
      for (const row of order) got.push(await keys.getApiKeyById(row.id));
      expect(got).toEqual(
        order.map((row) =>
          row.anthropicWorkspaceId
            ? { apiKey: same, anthropicWorkspaceId: row.anthropicWorkspaceId }
            : { apiKey: same },
        ),
      );
    }
    expect(await keys.resolveProviderKey(owner, 'anthropic', b.id)).toEqual({
      apiKey: same,
      anthropicWorkspaceId: 'wrkspc_row_b',
    });
    expect(await keys.resolveProviderKey(owner, 'anthropic', none.id)).toEqual({ apiKey: same });
  });

  it('refuses it on another service, a bad shape, and another owner', async () => {
    await expect(
      keys.setApiKey(owner, 'openai', 'ws', `test-oai-${tag}`, {
        anthropicWorkspaceId: 'wrkspc_x',
      }),
    ).rejects.toThrow('Only an Anthropic key can carry a workspace id.');
    const openai = await keys.setApiKey(owner, 'openai', 'plain', `test-oai-${tag}`);
    await expect(setWorkspace(owner, openai.id, 'wrkspc_x')).rejects.toThrow(
      'Only an Anthropic key can carry a workspace id.',
    );
    const ant = (await keys.listApiKeys(owner)).find((k) => k.service === 'anthropic')!;
    // Not ASCII letters, digits, _ or -: a space, a non-ASCII letter, a C1
    // control character, a dot. Each an InputError (a 400), never a 500.
    for (const bad of ['has space', 'wrkspc_é', 'wrkspc_\u0085x', 'wrkspc.x', 'x'.repeat(129)]) {
      await expect(setWorkspace(owner, ant.id, bad)).rejects.toBeInstanceOf(
        InputError,
      );
      await expect(
        keys.setApiKey(owner, 'anthropic', 'bad', `test-ant-${tag}-bad`, {
          anthropicWorkspaceId: bad,
        }),
      ).rejects.toBeInstanceOf(InputError);
    }
    expect(await setWorkspace(randomUUID(), ant.id, 'wrkspc_x')).toBeNull();
    // The table refuses it too, whatever writes it: another service, and the
    // same shapes the app refuses.
    await expect(
      exec(sqlTag`update api_keys set anthropic_workspace_id = 'x' where id = ${openai.id}`),
    ).rejects.toThrow();
    for (const bad of ['wrkspc_é', 'wrkspc_\u0085x', 'has space', '']) {
      await expect(
        exec(sqlTag`update api_keys set anthropic_workspace_id = ${bad} where id = ${ant.id}`),
      ).rejects.toThrow();
    }
  });
});
