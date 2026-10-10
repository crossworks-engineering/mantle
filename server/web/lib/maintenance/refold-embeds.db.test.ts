/**
 * Workspaces W2, clean derived text (plan 5.3 with R8, migration 0247), on a
 * real migrated Postgres. The phase's "done when":
 *
 *  - a page LEVELLED without its embed (a public page that embeds an admin
 *    file) finds none of the embed's words, and
 *  - a page GRANTED without its embed (to Team, the file to nobody) finds
 *    none of them either, through doc_text, chunks, keyword search, the
 *    summary or facts;
 *  - the extract queue is unchanged by the hand-run task (no notify, no job);
 *  - a marked fact is read in a scope that holds the Admin workspace only;
 *  - the old summary sits in node_mixed_summaries, which no limited role reads.
 *
 * The pre-W2 rows are written as the old commit path left them (embed text
 * folded into doc_text, the summary, a chunk and a fact), then marked with
 * the migration's own function and re-folded with a fake local embedder.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/refold-embeds.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('W2: a page without its embed finds none of its words', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let refold: typeof import('./refold-embeds');
  let admin: Admin;
  let anchor = '';
  const tag = `wsw2${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  // The embed's words: in its title and in its text. None may reach a reader
  // of the page who may not read the file.
  const SECRET = ['zanzibarquux', 'quokkaplinth', 'marmaladerift'];
  const file = randomUUID();
  const levelled = randomUUID();
  const granted = randomUUID();
  const member = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID() };
  const vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  const vecLit = `[${vec.join(',')}]`;
  const deps = {
    embedBatch: async (_o: string, texts: string[]) => texts.map(() => vec),
    windowsEnabled: async () => false,
    planWindows: () => ({ copies: [], embeds: [] }),
  };

  const oldFold = `Pump overhaul notes.\n\n[Embedded file: ${SECRET[0]}.png]\n${SECRET[1]} ${SECRET[2]} calibration`;
  const docWithEmbed = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Pump overhaul notes.' }] },
      { type: 'image', attrs: { nodeId: file, alt: `${SECRET[0]}.png`, src: null } },
    ],
  };

  /** A page as the pre-W2 commit path left it: the embed's words in its
   *  doc_text, its summary, one chunk and one live fact. */
  async function oldPage(id: string, audience: string) {
    await admin`insert into nodes (id, owner_id, type, title, path, audience, data, embedding)
      values (${id}, ${anchor}, 'page', ${`${tag} pump page`}, 'pages', ${audience},
              ${JSON.stringify({ summary: `Pump overhaul with ${SECRET[1]} calibration`, entities: [SECRET[2]!] })}::jsonb,
              ${vecLit}::vector)`;
    await admin`insert into pages (node_id, doc, doc_text)
      values (${id}, ${JSON.stringify(docWithEmbed)}::jsonb, ${oldFold})`;
    await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
      values (${anchor}, ${id}, 0, ${oldFold}, ${vecLit}::vector)`;
    await admin`insert into facts (owner_id, kind, content, source_node_id, embedding)
      values (${anchor}, 'factual', ${`${tag} ${SECRET[1]} calibration is due`}, ${id}, ${vecLit}::vector)`;
  }

  /** What a reader finds of the secret words, through every derived store. */
  async function found(): Promise<string[]> {
    const hits: string[] = [];
    for (const w of SECRET) {
      const like = `%${w}%`;
      const r = (await m.db.execute(m.sql`
        select
          (select count(*) from pages p where p.node_id in (${levelled}, ${granted})
              and p.doc_text ilike ${like})::int as doc_text,
          (select count(*) from content_chunks c where c.node_id in (${levelled}, ${granted})
              and c.text ilike ${like})::int as chunks,
          (select count(*) from nodes n where n.id in (${levelled}, ${granted})
              and (n.search_tsv @@ plainto_tsquery('english', ${w}) or n.data::text ilike ${like}))::int as nodes,
          (select count(*) from facts f where f.source_node_id in (${levelled}, ${granted})
              and f.content ilike ${like})::int as facts,
          (select count(*) from nodes n where n.id in (${levelled}, ${granted}))::int as pages_seen`)) as unknown as Record<
        string,
        number
      >[];
      const row = r[0]!;
      for (const k of ['doc_text', 'chunks', 'nodes', 'facts'])
        if (row[k]! > 0) hits.push(`${k}:${w}`);
      if (row.pages_seen === 0) hits.push('page not readable at all');
    }
    return hits;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    refold = await import('./refold-embeds');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`;
    await admin`insert into nodes (id, owner_id, type, title, path, audience, data)
      values (${file}, ${anchor}, 'file', ${`${SECRET[0]}.png`}, 'files', 'admin',
              ${JSON.stringify({ text: `${SECRET[1]} ${SECRET[2]} calibration` })}::jsonb)`;
    await oldPage(levelled, 'public');
    await oldPage(granted, 'admin');
    await admin`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true),
      (${ws.team}, ${anchor}, ${`${tag} Team`}, false)`;
    // The page is granted to Team and Admin; its embed to neither.
    await admin`insert into item_grants (node_id, workspace_id, is_home) values
      (${granted}, ${ws.admin}, true), (${granted}, ${ws.team}, false)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from item_grants where node_id in (${granted}, ${levelled}, ${file})`;
    await admin`delete from facts where content like ${`${tag}%`}`;
    await admin`delete from nodes where id in (${levelled}, ${granted}, ${file})`;
    await admin`delete from workspaces where id in (${ws.admin}, ${ws.team})`;
    await admin`delete from spaces where login_id = ${member}`;
    await admin`delete from auth.users where id = ${member}`;
    await m?.closeDb();
  });

  it('before W2, the old rows leak (the control)', async () => {
    const leaked = await m.withViewer('public', found);
    for (const h of [
      `doc_text:${SECRET[1]}`,
      `chunks:${SECRET[1]}`,
      `nodes:${SECRET[1]}`,
      `facts:${SECRET[1]}`,
    ]) {
      expect(leaked).toContain(h);
    }
  });

  it('the mark sets the old summary aside and hides the old facts; the re-fold changes no queue', async () => {
    const marked = (await admin`
      select * from mantle_mark_derived_mixed(false, ${[levelled, granted]}::uuid[])`) as unknown as {
      node_type: string;
      nodes_marked: string;
      summaries_moved: string;
      facts_marked: string;
    }[];
    expect(marked).toEqual([
      { node_type: 'page', nodes_marked: '2', summaries_moved: '2', facts_marked: '2' },
    ]);
    // Idempotent.
    const again =
      await admin`select * from mantle_mark_derived_mixed(false, ${[levelled, granted]}::uuid[])`;
    expect(again).toEqual([]);

    const notified: string[] = [];
    const sub = await admin.listen('node_ingested', (id) => notified.push(id));
    const jobs = async () => {
      try {
        const [r] = await admin<{ n: number }[]>`select count(*)::int as n from pgboss.job`;
        return r!.n;
      } catch {
        return -1; // no pg-boss schema on this database
      }
    };
    const jobsBefore = await jobs();
    const updatedBefore = await admin<{ id: string; u: string }[]>`
      select id, updated_at::text as u from nodes where id in (${levelled}, ${granted}) order by id`;
    const dry = await refold.refoldEmbeds(anchor, { apply: false, ids: [levelled, granted], deps });
    expect(dry).toMatchObject({ textRewritten: 2, rechunked: 2, nodeVectors: 2 });
    expect(dry.marked.page).toBe(2);
    const r = await refold.refoldEmbeds(anchor, { apply: true, ids: [levelled, granted], deps });
    expect(r).toMatchObject({ textRewritten: 2, rechunked: 2, nodeVectors: 2 });
    // Resumable: a second run finds nothing to do.
    const r2 = await refold.refoldEmbeds(anchor, { apply: true, ids: [levelled, granted], deps });
    expect(r2.unchanged).toBe(2);
    await new Promise((res) => setTimeout(res, 300));
    await sub.unlisten();
    expect(notified.filter((id) => id === levelled || id === granted)).toEqual([]);
    expect(await jobs()).toBe(jobsBefore);
    const updatedAfter = await admin<{ id: string; u: string }[]>`
      select id, updated_at::text as u from nodes where id in (${levelled}, ${granted}) order by id`;
    expect(updatedAfter.map((x) => x.u)).toEqual(updatedBefore.map((x) => x.u));

    const [side] = await admin<{ n: number }[]>`
      select count(*)::int as n from node_mixed_summaries
       where node_id in (${levelled}, ${granted}) and summary like ${`%${SECRET[1]}%`}`;
    expect(side!.n).toBe(2);
    const [p] = await admin<
      { t: string }[]
    >`select doc_text as t from pages where node_id = ${levelled}`;
    // At public the redactor leaves an unreadable picture out (no marker either).
    expect(p!.t).toBe('Pump overhaul notes.');
  });

  it('LEVELLED without its embed: the public reader finds none of its words', async () => {
    expect(await m.withViewer('public', found)).toEqual([]);
  });

  it('GRANTED without its embed: a Team scope finds none of its words', async () => {
    const hits = await m.withScope(
      { kind: 'user', ws: [ws.team], modWs: [], loginId: member },
      found,
    );
    expect(hits).toEqual([]);
  });

  it('a marked fact is read only in a scope that holds the Admin workspace', async () => {
    const count = () =>
      m.db
        .select({ id: m.facts.id })
        .from(m.facts)
        .where(m.eq(m.facts.sourceNodeId, granted))
        .then((x) => x.length);
    expect(
      await m.withScope({ kind: 'user', ws: [ws.team], modWs: [], loginId: member }, count),
    ).toBe(0);
    expect(
      await m.withScope(
        { kind: 'user', ws: [ws.admin, ws.team], modWs: [], loginId: member },
        count,
      ),
    ).toBe(1);
  });

  it('no limited role reads node_mixed_summaries', async () => {
    for (const role of [
      'mantle_view_team',
      'mantle_view_client',
      'mantle_view_public',
      'mantle_view_user',
    ]) {
      const r = await admin.reserve();
      try {
        await r`begin`;
        await r.unsafe(`set local role ${role}`);
        await expect(r`select count(*) from node_mixed_summaries`).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await r`rollback`.catch(() => {});
        r.release();
      }
    }
    expect((await m.olderSummaryOf(granted))?.label).toBe(m.OLDER_SUMMARY_LABEL);
  });
});
