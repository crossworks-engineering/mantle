/**
 * translate on a real migrated Postgres: a workspace scope translates only
 * the items it reads (row level security on nodes); an item it does not
 * read answers as a random id and spends nothing. `save` in the brain's own
 * work makes the copy, linked to its original. The model is stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-translate.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor, superuserExec } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const sent: string[] = [];

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDefaultWorker: vi.fn(async (_o: string, kind: string) => ({
    ok: true,
    worker: {
      id: `w-${kind}`,
      slug: `test-${kind}`,
      kind,
      provider: 'openrouter',
      model: 'test/model',
      apiKeyId: 'k',
      params: {},
      systemPrompt: null,
    },
    credential: { apiKey: 'test' },
  })),
}));
vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: () => ({
    adapterName: 'stub-chat',
    chat: async (opts: { messages: { content: string }[] }) => {
      const user = opts.messages[1]!.content;
      sent.push(user);
      const lines = user.split('\n');
      const a = lines.findIndex((l) => l.startsWith('[BEGIN RETRIEVED CONTENT'));
      const b = lines.findIndex((l) => l.startsWith('[END RETRIEVED CONTENT'));
      return {
        text: `DE ${lines.slice(a + 1, b).join('\n')}`,
        model: 'test/model',
        finishReason: 'stop',
      };
    },
  }),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshModelCatalog: vi.fn(async () => {}),
}));

describe.skipIf(!URL)('translate never reads an item the caller cannot', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let c: typeof import('@mantle/content');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `tr-${randomUUID().slice(0, 8)}`;
  let anchor: string;
  const ids: string[] = [];
  let open = '';
  let hidden = '';
  const wsId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    open = (await c.createNote(anchor, { title: `${tag} open`, content: `${tag} open words` })).id;
    hidden = (
      await c.createNote(anchor, { title: `${tag} hidden`, content: `${tag} secret words` })
    ).id;
    ids.push(open, hidden);
    await superuserExec(
      URL!,
      sqlTag`insert into workspaces (id, owner_id, name) values (${wsId}, ${anchor}, ${`${tag} ws`})`,
    );
    await m.withHeads([open], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id) values (${open}, ${wsId})`),
    );
  }, 60_000);

  afterAll(async () => {
    for (const id of ids) {
      await m.systemDb.execute(sqlTag`delete from item_grants where node_id = ${id}`);
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await superuserExec(URL!, sqlTag`delete from workspaces where id = ${wsId}`);
    await m.closeDb();
  });

  it('a workspace scope reads its own item and answers a hidden one as a random id', async () => {
    const { translateTool } = await import('./builtins-translate');
    const ctx = { ownerId: anchor, surface: { kind: 'web' } } as Parameters<
      typeof translateTool.handler
    >[1];
    const inScope = <T>(fn: () => Promise<T>) =>
      m.withTurnScope({ kind: 'assistant', loginId: null, ws: [wsId], modWs: [] }, fn);

    const ok = await inScope(() => translateTool.handler({ node_id: open, to: 'de' }, ctx));
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok)).toContain(`DE ${tag} open words`);

    sent.length = 0;
    const no = await inScope(() => translateTool.handler({ node_id: hidden, to: 'de' }, ctx));
    const random = randomUUID();
    const rnd = await inScope(() => translateTool.handler({ node_id: random, to: 'de' }, ctx));
    expect(no.ok).toBe(false);
    expect((no as { error: string }).error.replace(hidden, '<id>')).toBe(
      (rnd as { error: string }).error.replace(random, '<id>'),
    );
    // Nothing of the hidden note reached the model.
    expect(sent).toHaveLength(0);
  });

  it("the brain's own work saves a note copy, linked to its original", async () => {
    const { translateTool } = await import('./builtins-translate');
    const ctx = { ownerId: anchor, surface: { kind: 'web' } } as Parameters<
      typeof translateTool.handler
    >[1];
    const r = await translateTool.handler({ node_id: hidden, to: 'de', save: true }, ctx);
    expect(r.ok).toBe(true);
    const saved = (r as { output: { saved: { id: string; kind: string; title: string } } }).output
      .saved;
    ids.push(saved.id);
    expect(saved).toMatchObject({ kind: 'note', title: `${tag} hidden (German)` });
    const [row] = (await m.systemDb.execute(
      sqlTag`select type, data from nodes where id = ${saved.id}`,
    )) as unknown as Array<{ type: string; data: Record<string, unknown> }>;
    expect(row!.type).toBe('note');
    expect(row!.data.content).toBe(`DE ${tag} secret words`);
    expect(row!.data.translationOf).toEqual({ id: hidden, to: 'de' });
  });
});
