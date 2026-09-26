/**
 * Setting levels against a real, migrated Postgres (member logins Phase 0b):
 * the type ceiling, share closure (lowered or raised on request only, the two
 * never mixed), and the agent / tool-group rule. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/access.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('setting levels on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Access = typeof import('./access');
  let m: Db;
  let a: Access;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = {
    page: randomUUID(),
    embeddedFile: randomUUID(),
    folder: randomUUID(),
    child: randomUUID(),
    publicChild: randomUUID(),
    journal: randomUUID(),
    agent: randomUUID(),
  };
  const tag = `access-test-${owner.slice(0, 8)}`;

  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.embeddedFile, src: 'x' } }],
    };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.page}, ${owner}, 'page', 'A page', 'pages'),
        (${ids.embeddedFile}, ${owner}, 'file', 'img.png', 'files'),
        (${ids.folder}, ${owner}, 'branch', 'shared', ${`files.${tag.replace(/-/g, '_')}`}),
        (${ids.child}, ${owner}, 'file', 'a.pdf', ${`files.${tag.replace(/-/g, '_')}`}),
        (${ids.publicChild}, ${owner}, 'note', 'n', ${`files.${tag.replace(/-/g, '_')}`}),
        (${ids.journal}, ${owner}, 'journal', 'j', 'journal')`);
    await m.db.execute(sqlTag`update nodes set audience = 'public' where id = ${ids.publicChild}`);
    await m.db.execute(
      sqlTag`insert into pages (node_id, doc, doc_text) values (${ids.page}, ${JSON.stringify(doc)}::jsonb, '')`,
    );
    await m.db.execute(sqlTag`
      insert into tool_groups (owner_id, slug, name, audience) values
        (${owner}, ${`${tag}-admin`}, 'admin group', 'admin'),
        (${owner}, ${`${tag}-team`}, 'team group', 'team')`);
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${ids.agent}, ${owner}, ${`${tag}-agent`}, 'A', 'm', 'p',
              ${`{${tag}-admin,${tag}-team}`}::text[])`);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('refuses a non-workspace kind below admin (the type ceiling)', async () => {
    await expect(a.setItemAudience(owner, ids.journal, 'team')).rejects.toMatchObject({
      code: 'type_ceiling',
    });
    expect(await audienceOf(ids.journal)).toBe('admin');
  });

  it('refuses a value that is not a level', async () => {
    await expect(a.setItemAudience(owner, ids.page, 'everyone')).rejects.toMatchObject({
      code: 'invalid_level',
    });
  });

  it('lowering a page reports its embedded file, and lowers it only when asked', async () => {
    const first = await a.setItemAudience(owner, ids.page, 'team');
    expect(first.stillAbove.map((i) => i.id)).toEqual([ids.embeddedFile]);
    expect(await audienceOf(ids.embeddedFile)).toBe('admin');

    const second = await a.setItemAudience(owner, ids.page, 'team', { withClosure: true });
    expect(second.lowered.map((i) => i.id)).toEqual([ids.embeddedFile]);
    expect(await audienceOf(ids.embeddedFile)).toBe('team');
  });

  it('a folder closure lowers its contents but never raises one', async () => {
    const res = await a.setItemAudience(owner, ids.folder, 'team', { withClosure: true });
    expect(res.lowered.map((i) => i.id)).toEqual([ids.child]);
    expect(await audienceOf(ids.child)).toBe('team');
    expect(await audienceOf(ids.publicChild), 'a public child stays public').toBe('public');
  });

  it('raising a folder reports what it holds below, and raises it only when asked (MED 7)', async () => {
    // The public child carries its own open link: raising it must revoke it,
    // or an admin item would keep an open link.
    const linked = await a.setItemLevel(owner, ids.publicChild, 'public');
    expect(linked.share).not.toBeNull();

    const first = await a.setItemLevel(owner, ids.folder, 'admin');
    expect(first.stillBelow.map((i) => i.id).sort()).toEqual([ids.child, ids.publicChild].sort());
    expect(first.raised).toEqual([]);
    expect(await audienceOf(ids.child), 'nothing follows on its own').toBe('team');

    // "Lower them too" must never raise: withClosure alone leaves them below.
    await a.setItemLevel(owner, ids.folder, 'admin', { withClosure: true });
    expect(await audienceOf(ids.publicChild)).toBe('public');

    const second = await a.setItemLevel(owner, ids.folder, 'admin', { raiseClosure: true });
    expect(second.raised.map((i) => i.id).sort()).toEqual([ids.child, ids.publicChild].sort());
    expect(await audienceOf(ids.child)).toBe('admin');
    expect(await audienceOf(ids.publicChild)).toBe('admin');
    const shares = await import('./shares');
    expect(
      await shares.getActiveShareForNode(owner, ids.publicChild),
      'its link follows',
    ).toBeNull();
  });

  it('an agent cannot be lowered while it holds a group above the new level', async () => {
    await expect(a.setAgentAudience(owner, ids.agent, 'team')).rejects.toMatchObject({
      code: 'group_above_agent',
    });
    await m.db.execute(
      sqlTag`update agents set tool_group_slugs = ${`{${tag}-team}`}::text[] where id = ${ids.agent}`,
    );
    await expect(a.setAgentAudience(owner, ids.agent, 'team')).resolves.toMatchObject({
      audience: 'team',
    });
  });

  it('a tool group cannot be raised above an agent that holds it', async () => {
    await expect(a.setToolGroupAudience(owner, `${tag}-team`, 'admin')).rejects.toMatchObject({
      code: 'group_above_agent',
    });
    await expect(a.setToolGroupAudience(owner, `${tag}-team`, 'client')).resolves.toMatchObject({
      audience: 'client',
    });
  });
});
