/**
 * An Anthropic key's workspace id, against a real database (0292): stored
 * with the key, read back on every open so the adapter can send it, cleared
 * the same way, and refused on any other service. Placeholder key strings
 * only; nothing calls Anthropic.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run anthropic-workspace.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerKeyContext, _clearProviderKeyContexts } from '@mantle/std';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('an Anthropic key carries its workspace id', () => {
  let m: typeof import('@mantle/db');
  let keys: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `anthropic-ws-${owner.slice(0, 8)}`;
  let prevMasterKey: string | undefined;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevMasterKey = process.env.MANTLE_MASTER_KEY;
    process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    m = await import('@mantle/db');
    keys = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
  }, 60_000);

  afterAll(async () => {
    _clearProviderKeyContexts();
    if (!m) return;
    await exec(sqlTag`delete from api_keys where user_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
    if (prevMasterKey === undefined) delete process.env.MANTLE_MASTER_KEY;
    else process.env.MANTLE_MASTER_KEY = prevMasterKey;
  }, 60_000);

  it('stores it with the key and records it on every open', async () => {
    const plaintext = `test-ant-${tag}-a`;
    const row = await keys.setApiKey(owner, 'anthropic', 'ws', plaintext, {
      anthropicWorkspaceId: '  wrkspc_test_one  ',
    });
    expect(row.anthropicWorkspaceId).toBe('wrkspc_test_one');
    _clearProviderKeyContexts();
    expect(await keys.getApiKeyById(row.id)).toBe(plaintext);
    expect(providerKeyContext(plaintext)).toEqual({ anthropicWorkspaceId: 'wrkspc_test_one' });

    const listed = (await keys.listApiKeys(owner)).find((k) => k.id === row.id);
    expect(listed?.anthropicWorkspaceId).toBe('wrkspc_test_one');

    // Every lookup opens through the same place.
    _clearProviderKeyContexts();
    expect(await keys.resolveProviderKey(owner, 'anthropic')).toBe(plaintext);
    expect(providerKeyContext(plaintext)?.anthropicWorkspaceId).toBe('wrkspc_test_one');
  });

  it('keeps it on a re-save that does not name it, and clears it when asked', async () => {
    const plaintext = `test-ant-${tag}-b`;
    const row = await keys.setApiKey(owner, 'anthropic', 'ws', plaintext);
    expect(row.anthropicWorkspaceId).toBe('wrkspc_test_one');

    const cleared = await keys.setApiKeyAnthropicWorkspace(owner, row.id, '  ');
    expect(cleared?.anthropicWorkspaceId).toBeNull();
    expect(await keys.getApiKeyById(row.id)).toBe(plaintext);
    expect(providerKeyContext(plaintext)).toBeUndefined();

    const set = await keys.setApiKeyAnthropicWorkspace(owner, row.id, 'wrkspc_test_two');
    expect(set?.anthropicWorkspaceId).toBe('wrkspc_test_two');
    await keys.getApiKeyById(row.id);
    expect(providerKeyContext(plaintext)?.anthropicWorkspaceId).toBe('wrkspc_test_two');
  });

  it('refuses it on another service, a bad shape, and another owner', async () => {
    await expect(
      keys.setApiKey(owner, 'openai', 'ws', `test-oai-${tag}`, {
        anthropicWorkspaceId: 'wrkspc_x',
      }),
    ).rejects.toThrow('Only an Anthropic key can carry a workspace id.');
    const openai = await keys.setApiKey(owner, 'openai', 'plain', `test-oai-${tag}`);
    await expect(keys.setApiKeyAnthropicWorkspace(owner, openai.id, 'wrkspc_x')).rejects.toThrow(
      'Only an Anthropic key can carry a workspace id.',
    );
    const ant = (await keys.listApiKeys(owner)).find((k) => k.service === 'anthropic')!;
    await expect(keys.setApiKeyAnthropicWorkspace(owner, ant.id, 'has space')).rejects.toThrow(
      /spaces or control characters/,
    );
    expect(await keys.setApiKeyAnthropicWorkspace(randomUUID(), ant.id, 'wrkspc_x')).toBeNull();
    // The table refuses it too, whatever writes it.
    await expect(
      exec(sqlTag`update api_keys set anthropic_workspace_id = 'x' where id = ${openai.id}`),
    ).rejects.toThrow();
  });
});
