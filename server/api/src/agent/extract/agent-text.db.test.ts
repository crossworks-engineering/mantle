/**
 * The text of the Agents' tabs on a file node (`data.agent_text`,
 * ./agent-text.ts), on a migrated scratch database with BOTH checks on (the
 * actor check and the edit check), written the way the extract queue runs
 * the job of an Agent's run (the system scope `queue:extract`):
 *
 *  - the text goes in by the Agent's id, and the node's other data stays;
 *  - a plain keyword search (`search_tsv`) finds a word of it;
 *  - a second Agent's text sits beside the first; '' takes one out;
 *  - `updated_at` stays;
 *  - a file in the name-only mode gets none, nor a file whose bytes changed;
 *  - a person's write may not set the key (the edit check, 0377).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/agent-text.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Agents’ text on a file node, both checks on', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let writeAgentText: typeof import('./agent-text').writeAgentText;
  const owner = randomUUID();
  const SHA = 'a'.repeat(64);
  const tag = `atx${randomUUID().slice(0, 6)}`;

  const extract = <T>(fn: () => Promise<T>) => m.runAsSystem('queue:extract', fn) as Promise<T>;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  const fileNode = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID();
    const filename = `drawing-${id.slice(0, 8)}.pdf`;
    await x(sql`insert into nodes (id, owner_id, type, title, path, data, updated_at) values
      (${id}, ${owner}, 'file', ${filename}, 'files',
       ${JSON.stringify({ filename, mimeType: 'application/pdf', sha256: SHA, keep: 'me', ...extra })}::jsonb,
       '2026-01-01T00:00:00Z')`);
    return id;
  };
  const rowOf = async (id: string) =>
    (
      await x<{ data: Record<string, unknown>; updated_at: string | Date }>(
        sql`select data, updated_at from nodes where id = ${id}`,
      )
    )[0]!;
  const found = async (id: string, word: string) =>
    (
      await x<{ n: number }>(
        sql`select count(*)::int as n from nodes
             where id = ${id} and search_tsv @@ plainto_tsquery('english', ${word})`,
      )
    )[0]!.n === 1;

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ({ writeAgentText } = await import('./agent-text'));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
  }, 240_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    delete process.env.MANTLE_TEST_EDIT_CHECK;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('puts the text in by the Agent, keeps the rest, keeps updated_at, and a search finds it', async () => {
    const id = await fileNode();
    const before = await rowOf(id);
    const text = 'Title block\nLine number: 6-P-1001-A1A; Revision: B\n\nSheet list\nText: FV-1001';
    expect(await extract(() => writeAgentText(owner, id, SHA, 'pdf-sheet-read', text))).toBe(true);
    const after = await rowOf(id);
    expect(after.data.keep).toBe('me');
    expect(after.data.agent_text).toEqual({ 'pdf-sheet-read': text });
    expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
    expect(await found(id, 'FV-1001')).toBe(true);
    // A second Agent beside it; '' takes one out.
    await extract(() =>
      writeAgentText(owner, id, SHA, 'iso-title-block', 'Title block\nSheet: 1 of 2'),
    );
    expect(Object.keys((await rowOf(id)).data.agent_text as object).sort()).toEqual([
      'iso-title-block',
      'pdf-sheet-read',
    ]);
    await extract(() => writeAgentText(owner, id, SHA, 'pdf-sheet-read', ''));
    expect((await rowOf(id)).data.agent_text).toEqual({
      'iso-title-block': 'Title block\nSheet: 1 of 2',
    });
    expect(await found(id, 'FV-1001')).toBe(false);
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a file in the name-only mode gets no text', async () => {
    const id = await fileNode({ indexing_applied: 'metadata' });
    expect(
      await extract(() => writeAgentText(owner, id, SHA, 'pdf-sheet-read', 'Text: FV-1001')),
    ).toBe(false);
    expect((await rowOf(id)).data.agent_text).toBeUndefined();
  });

  it('another owner’s node, or new bytes, are not written', async () => {
    const id = await fileNode();
    expect(
      await extract(() => writeAgentText(randomUUID(), id, SHA, 'pdf-sheet-read', 'Text: FV-1001')),
    ).toBe(false);
    expect(
      await extract(() => writeAgentText(owner, id, 'b'.repeat(64), 'pdf-sheet-read', 'Text: X')),
    ).toBe(false);
    expect((await rowOf(id)).data.agent_text).toBeUndefined();
  });

  it('the key is one of the derived keys: a person’s write may not set it (0377)', async () => {
    const keys = await x<{ k: string[] }>(sql`select "public"."mantle_node_derived_keys"() as k`);
    expect(keys[0]!.k).toContain('agent_text');
    const extractor = await x<{ k: string[] }>(
      sql`select "public"."mantle_node_extractor_keys"() as k`,
    );
    expect(extractor[0]!.k).toContain('agent_text');
  });
});
