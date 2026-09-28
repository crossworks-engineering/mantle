/**
 * The Forum archive export (member logins, Phase 6) on a real, migrated
 * Postgres. A seeded forum (a team topic and a private one, posts by a
 * member, the admin and the agent, uploads filed, pending, staged, dismissed
 * and with lost bytes, a topic whose agent reply is still in flight, a
 * request task) is exported twice:
 *
 *   - one admin-level page per exported topic under ONE "Forum archive" page,
 *     each post with its author, kind, time, body, the agent's model and a
 *     trace link, and links to its files; node_id is the done-marker;
 *   - unreviewed uploads filed into files/review/forum-archive, metadata-only;
 *   - a JSON dump in files/archive, metadata-only;
 *   - the request task gets data.teamRequest.archivePageId;
 *   - cost-safety: nothing reaches the extractor that could spend. Every node
 *     the export creates is announced by the insert trigger (the pipeline's
 *     queue entry point, observed here with LISTEN, as the extractor does);
 *     each announced page is extraction-exempt and each file metadata-only,
 *     the drain predicate never returns a page, no summarizer is woken, no
 *     trace or embedding is written, and no pg-boss job is queued;
 *   - the second run creates nothing, and a run while another holds the lock
 *     answers `busy`.
 * Seeds its own brain row, contact, forum and files root; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/forum/export.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('forum archive export', () => {
  let ex: typeof import('./export');
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let unlisten: () => Promise<void>;
  const ingested: string[] = [];
  const summarizeDue: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-forum-export-'));
  const tag = `fx-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const NOW = new Date('2026-09-28T09:00:00.000Z');
  const since = new Date('2026-01-01T00:00:00.000Z');

  const ids = {
    pat: randomUUID(), // member contact
    teamTopic: randomUUID(),
    privateTopic: randomUUID(),
    busyTopic: randomUUID(), // agent reply still pending
    memberPost: randomUUID(),
    agentPost: randomUUID(),
    ownerPost: randomUUID(),
    privatePost: randomUUID(),
    busyPost: randomUUID(),
    busyAgent: randomUUID(),
    filedNode: randomUUID(), // a file the admin filed long ago
    upPending: randomUUID(), // pending, bytes present
    upFiled: randomUUID(),
    upDismissed: randomUUID(),
    upLost: randomUUID(), // pending, bytes gone
    upStaged: randomUUID(), // staged, no topic, bytes present
    task: randomUUID(),
    trace: randomUUID(),
  };

  const quarantine = (id: string) => path.join(root, 'forum-uploads', anchor, id);
  const archivePages = () =>
    admin<Row[]>`
      select n.id, n.title, n.parent_id, n.audience, n.data, n.embedding is null as no_vec,
             p.doc_text, p.doc
        from nodes n join pages p on p.node_id = n.id
       where n.owner_id = ${anchor} and n.type = 'page'
         and n.data->>'source' = 'forum-archive'
       order by n.created_at`;
  const nodeCount = async () =>
    Number(
      (await admin<Row[]>`select count(*)::int as n from nodes where owner_id = ${anchor}`)[0]!.n,
    );
  const settle = () => new Promise((r) => setTimeout(r, 400));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    ex = await import('./export');

    const a = await admin.listen('node_ingested', (id: string) => ingested.push(id));
    const b = await admin.listen('summarize_due', (id: string) => summarizeDue.push(id));
    unlisten = async () => {
      await a.unlisten();
      await b.unlisten();
    };

    await admin`insert into auth.users (id, email, password_hash, role)
                values (${anchor}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${ids.pat}, ${anchor}, 'contact', 'Pat Doe', 'contacts', '{}'::jsonb),
      (${ids.filedNode}, ${anchor}, 'file', 'old-report.pdf', 'files',
        '{"filename":"old-report.pdf"}'::jsonb),
      (${ids.task}, ${anchor}, 'task', 'Fix the printer', 'tasks',
        ${JSON.stringify({ teamRequest: { topicId: ids.teamTopic, contactId: ids.pat } })}::jsonb)`;

    await admin`insert into forum_topics
        (id, owner_id, title, kind, visibility, status, pinned, created_by_contact_id,
         author_name, post_count, created_at)
      values
        (${ids.teamTopic}, ${anchor}, 'Printer on floor 2', 'bug', 'team', 'answered', true,
         ${ids.pat}, 'Pat Doe', 3, '2026-09-01T10:00:00Z'),
        (${ids.privateTopic}, ${anchor}, 'My pay slip', 'question', 'private', 'open', false,
         ${ids.pat}, 'Pat Doe', 1, '2026-09-02T10:00:00Z'),
        (${ids.busyTopic}, ${anchor}, 'Still thinking', 'question', 'team', 'open', false,
         ${ids.pat}, 'Pat Doe', 2, '2026-09-03T10:00:00Z')`;
    const att = (fileId: string, kind = 'document') => ({ kind, fileId });
    await admin`insert into forum_posts
        (id, owner_id, topic_id, author_kind, contact_id, author_name, model, trace_id, body,
         attachments, status, created_at)
      values
        (${ids.memberPost}, ${anchor}, ${ids.teamTopic}, 'member', ${ids.pat}, 'Pat Doe', null, null,
         'The **printer** jams on page 2.',
         ${JSON.stringify([att(ids.upPending), att(ids.upFiled), att(ids.upDismissed)])}::jsonb,
         'complete', '2026-09-01T10:00:00Z'),
        (${ids.agentPost}, ${anchor}, ${ids.teamTopic}, 'agent', null, 'Team Responder',
         'openai/gpt-test', ${ids.trace}, 'Try the rear tray.',
         ${JSON.stringify([{ kind: 'document', nodeId: ids.filedNode }])}::jsonb,
         'complete', '2026-09-01T10:01:00Z'),
        (${ids.ownerPost}, ${anchor}, ${ids.teamTopic}, 'owner', null, 'The Admin', null, null,
         'Fixed it, thanks.', '[]'::jsonb, 'complete', '2026-09-01T11:00:00Z'),
        (${ids.privatePost}, ${anchor}, ${ids.privateTopic}, 'member', ${ids.pat}, 'Pat Doe', null,
         null, 'Secret salary question.', ${JSON.stringify([att(ids.upLost)])}::jsonb,
         'complete', '2026-09-02T10:00:00Z'),
        (${ids.busyPost}, ${anchor}, ${ids.busyTopic}, 'member', ${ids.pat}, 'Pat Doe', null, null,
         'Anyone?', '[]'::jsonb, 'complete', '2026-09-03T10:00:00Z'),
        (${ids.busyAgent}, ${anchor}, ${ids.busyTopic}, 'agent', null, 'Team Responder', null, null,
         '', '[]'::jsonb, 'pending', '2026-09-03T10:00:05Z')`;
    await admin`insert into forum_uploads
        (id, owner_id, topic_id, post_id, contact_id, filename, mime, size_bytes, status, node_id)
      values
        (${ids.upPending}, ${anchor}, ${ids.teamTopic}, ${ids.memberPost}, ${ids.pat},
         'jam.txt', 'text/plain', 11, 'pending', null),
        (${ids.upFiled}, ${anchor}, ${ids.teamTopic}, ${ids.memberPost}, ${ids.pat},
         'old-report.pdf', 'application/pdf', 2048, 'filed', ${ids.filedNode}),
        (${ids.upDismissed}, ${anchor}, ${ids.teamTopic}, ${ids.memberPost}, ${ids.pat},
         'junk.bin', 'application/octet-stream', 5, 'dismissed', null),
        (${ids.upLost}, ${anchor}, ${ids.privateTopic}, ${ids.privatePost}, ${ids.pat},
         'payslip.pdf', 'application/pdf', 900, 'pending', null),
        (${ids.upStaged}, ${anchor}, null, null, ${ids.pat},
         'draft.txt', 'text/plain', 5, 'staged', null)`;
    mkdirSync(path.dirname(quarantine(ids.upPending)), { recursive: true });
    writeFileSync(quarantine(ids.upPending), 'paper jam!\n');
    writeFileSync(quarantine(ids.upStaged), 'draft');
  });

  afterAll(async () => {
    if (!admin) return;
    await unlisten?.();
    await admin`delete from forum_topics where owner_id = ${anchor}`;
    await admin`delete from forum_uploads where owner_id = ${anchor}`;
    await admin`delete from traces where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where id = ${anchor}`;
    await admin`delete from auth.users where id = ${anchor}`;
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  let first: Awaited<ReturnType<typeof ex.exportForumArchive>>;
  let rootId: string;
  let teamPageId: string;
  let privatePageId: string;
  let filedPendingId: string;
  let stagedId: string;
  let dumpId: string;
  let ingestedAfterFirst: string[];

  it('reports the first run: two topics, one deferred, uploads filed and missing', async () => {
    first = await ex.exportForumArchive(anchor, { now: NOW });
    expect(first).toMatchObject({
      status: 'done',
      exported: 2,
      deferred: 1,
      alreadyExported: 0,
      uploadsFiled: 2,
      uploadsMissing: 1,
      tasksLinked: 1,
    });
    await settle();
    ingestedAfterFirst = [...ingested];
  });

  it('writes one admin-level page per topic under a single archive page', async () => {
    const pages = await archivePages();
    expect(pages).toHaveLength(3);
    const roots = pages.filter(
      (p) => (p.data as Row).forumArchive && ((p.data as Row).forumArchive as Row).kind === 'index',
    );
    expect(roots).toHaveLength(1);
    rootId = roots[0]!.id as string;
    expect(first.status === 'done' && first.archivePageId).toBe(rootId);
    expect(roots[0]!.title).toBe('Forum archive');
    for (const p of pages) {
      expect(p.audience).toBe('admin');
      expect(p.no_vec).toBe(true);
      expect((p.data as Row).summary).toBeUndefined();
    }
    const topicPages = pages.filter((p) => p.id !== rootId);
    for (const p of topicPages) expect(p.parent_id).toBe(rootId);
    const byTopic = (id: string) =>
      topicPages.find((p) => ((p.data as Row).forumArchive as Row).topicId === id)!;
    teamPageId = byTopic(ids.teamTopic).id as string;
    privatePageId = byTopic(ids.privateTopic).id as string;
    expect(byTopic(ids.teamTopic).title).toBe('Printer on floor 2');
    expect(byTopic(ids.privateTopic).title).toBe('My pay slip');
    expect(
      topicPages.some((p) => ((p.data as Row).forumArchive as Row).topicId === ids.busyTopic),
    ).toBe(false);
  });

  it('keeps every post: author, kind, time, body, the agent model and trace', async () => {
    const pages = await archivePages();
    const team = pages.find((p) => p.id === teamPageId)!;
    const text = team.doc_text as string;
    expect(text).toContain('Pat Doe (member) · 2026-09-01 10:00 UTC');
    expect(text).toContain('printer');
    expect(text).toContain('Team Responder (agent) · 2026-09-01 10:01 UTC');
    expect(text).toContain('model openai/gpt-test');
    expect(text).toContain(`trace ${ids.trace}`);
    expect(JSON.stringify(team.doc)).toContain(`/traces/${ids.trace}`);
    expect(text).toContain('The Admin (owner)');
    expect(text).toContain('Fixed it, thanks.');
    expect(text).toMatch(/Team topic/);
    const priv = pages.find((p) => p.id === privatePageId)!;
    expect(priv.doc_text).toContain('Private topic');
    expect(priv.doc_text).toContain('Secret salary question.');
  });

  it('files unreviewed uploads metadata-only and links every attachment', async () => {
    const files = await admin<Row[]>`
      select id, title, data, path::text as path from nodes
       where owner_id = ${anchor} and type = 'file'
         and path::text = ${ex.FORUM_ARCHIVE_UPLOADS_PATH}
       order by created_at`;
    expect(files).toHaveLength(2);
    for (const f of files) expect((f.data as Row).indexing).toBe('metadata');
    const byUpload = (id: string) =>
      files.find((f) => ((f.data as Row).forumArchive as Row).uploadId === id)!;
    filedPendingId = byUpload(ids.upPending).id as string;
    stagedId = byUpload(ids.upStaged).id as string;
    const folder = await admin<Row[]>`
      select data from nodes where owner_id = ${anchor} and type = 'branch'
         and path::text = ${ex.FORUM_ARCHIVE_UPLOADS_PATH}`;
    expect((folder[0]!.data as Row).indexing).toBe('metadata');

    const ups = await admin<
      Row[]
    >`select id, status, node_id from forum_uploads where owner_id = ${anchor}`;
    const up = (id: string) => ups.find((u) => u.id === id)!;
    expect(up(ids.upPending)).toMatchObject({ status: 'filed', node_id: filedPendingId });
    expect(up(ids.upStaged)).toMatchObject({ status: 'filed', node_id: stagedId });
    expect(up(ids.upLost)).toMatchObject({ status: 'pending', node_id: null });
    expect(up(ids.upDismissed).status).toBe('dismissed');
    expect(existsSync(quarantine(ids.upPending))).toBe(false);

    const pages = await archivePages();
    const teamDoc = JSON.stringify(pages.find((p) => p.id === teamPageId)!.doc);
    expect(teamDoc).toContain(filedPendingId); // newly filed
    expect(teamDoc).toContain(ids.filedNode); // filed long ago, and the agent's node
    expect(pages.find((p) => p.id === teamPageId)!.doc_text).toContain('dismissed by the admin');
    expect(pages.find((p) => p.id === privatePageId)!.doc_text).toContain('bytes were gone');
  });

  it('marks each exported topic with its page; the deferred one stays open', async () => {
    const topics = await admin<
      Row[]
    >`select id, node_id from forum_topics where owner_id = ${anchor}`;
    const t = (id: string) => topics.find((x) => x.id === id)!.node_id;
    expect(t(ids.teamTopic)).toBe(teamPageId);
    expect(t(ids.privateTopic)).toBe(privatePageId);
    expect(t(ids.busyTopic)).toBeNull();
    expect(await ex.countUnexportedForumTopics(anchor)).toBe(1);
  });

  it('gives the request task its archive page', async () => {
    const [task] = await admin<Row[]>`select data from nodes where id = ${ids.task}`;
    expect(((task!.data as Row).teamRequest as Row).archivePageId).toBe(teamPageId);
    expect(((task!.data as Row).teamRequest as Row).contactId).toBe(ids.pat);
  });

  it('writes the JSON dump metadata-only', async () => {
    const [dump] = await admin<Row[]>`
      select id, data from nodes where owner_id = ${anchor} and type = 'file'
         and path::text = ${ex.FORUM_ARCHIVE_DUMP_PATH}`;
    dumpId = dump!.id as string;
    expect(first.status === 'done' && first.dumpFileId).toBe(dumpId);
    expect((dump!.data as Row).filename).toBe('forum-2026-09-28.json');
    expect((dump!.data as Row).indexing).toBe('metadata');
    const json = JSON.parse(
      readFileSync(path.join(root, 'files', 'archive', 'forum-2026-09-28.json'), 'utf8'),
    ) as { topics: Array<Row & { posts: Row[] }>; uploads: Row[]; format: string };
    expect(json.format).toBe('mantle.forum-archive/1');
    expect(json.topics).toHaveLength(3);
    expect(json.topics.find((t) => t.id === ids.privateTopic)!.posts[0]!.body).toBe(
      'Secret salary question.',
    );
    expect(json.uploads.find((u) => u.id === ids.upLost)!.bytesMissing).toBe(true);
  });

  it('queues nothing that can spend: pages exempt, files metadata-only, no summarizer', async () => {
    const created = await admin<Row[]>`
      select id, type, data from nodes where owner_id = ${anchor}
         and id not in (${ids.pat}, ${ids.filedNode}, ${ids.task})`;
    const createdIds = created.map((c) => c.id as string);
    // Every non-folder node the export made was announced by the insert
    // trigger (the extractor's queue entry point), and nothing else was.
    const announced = ingestedAfterFirst.filter((id) => createdIds.includes(id));
    expect(new Set(announced)).toEqual(
      new Set(created.filter((c) => c.type !== 'branch').map((c) => c.id as string)),
    );
    for (const c of created.filter((x) => announced.includes(x.id as string))) {
      if (c.type === 'page') expect(m.isExtractExempt({ data: c.data }), `page ${c.id}`).toBe(true);
      else expect([c.type, (c.data as Row).indexing]).toEqual(['file', 'metadata']);
    }
    // The extractor's safety nets never pick a page up again.
    const drain = await m.db
      .select({ id: m.nodes.id, type: m.nodes.type })
      .from(m.nodes)
      .where(m.unextractedNodeConds(anchor, since));
    expect(drain.filter((d) => d.type === 'page')).toEqual([]);
    expect(drain.map((d) => d.id)).toEqual(expect.arrayContaining([filedPendingId, dumpId]));
    // No summarizer woken, no extractor run, no vector written.
    expect(summarizeDue).toEqual([]);
    const traces = await admin<Row[]>`select id from traces where owner_id = ${anchor}`;
    expect(traces).toEqual([]);
    const vecs = await admin<
      Row[]
    >`select id from nodes where owner_id = ${anchor} and embedding is not null`;
    expect(vecs).toEqual([]);
    const [boss] = await admin<Row[]>`select to_regclass('pgboss.job') as t`;
    if (boss!.t) {
      const jobs = await admin<Row[]>`
        select id from pgboss.job where data->>'nodeId' in ${admin(createdIds as never)}`;
      expect(jobs).toEqual([]);
    }
  });

  it('a second run creates nothing', async () => {
    const before = await nodeCount();
    const seen = ingested.length;
    const again = await ex.exportForumArchive(anchor, { now: NOW });
    expect(again).toMatchObject({
      status: 'done',
      exported: 0,
      deferred: 1,
      alreadyExported: 2,
      archivePageId: rootId,
      dumpFileId: null,
      uploadsFiled: 0,
      tasksLinked: 0,
    });
    await settle();
    expect(await nodeCount()).toBe(before);
    expect(ingested.length).toBe(seen);
    expect(await archivePages()).toHaveLength(3);
  });

  it('answers busy while another run holds the lock', async () => {
    const reserved = await admin.reserve();
    try {
      await reserved`select pg_advisory_lock(hashtextextended(${`forum-export:${anchor}`}, 0))`;
      expect(await ex.exportForumArchive(anchor, { now: NOW })).toEqual({ status: 'busy' });
      await reserved`select pg_advisory_unlock(hashtextextended(${`forum-export:${anchor}`}, 0))`;
    } finally {
      reserved.release();
    }
  });

  it('picks up the deferred topic once its reply lands, under the same archive page', async () => {
    await admin`update forum_posts set status = 'complete', body = 'Here now.'
                 where id = ${ids.busyAgent}`;
    const third = await ex.exportForumArchive(anchor, { now: NOW });
    expect(third).toMatchObject({
      status: 'done',
      exported: 1,
      deferred: 0,
      archivePageId: rootId,
    });
    const pages = await archivePages();
    expect(pages).toHaveLength(4);
    expect(
      pages.filter((p) => ((p.data as Row).forumArchive as Row).kind === 'index'),
    ).toHaveLength(1);
    expect(await ex.countUnexportedForumTopics(anchor)).toBe(0);
    // The day's dump is rewritten in place, not duplicated.
    expect(third.status === 'done' && third.dumpFileId).toBe(dumpId);
  });

  it('adopts a page an interrupted run left instead of making a second', async () => {
    // Simulate a crash after the page was created but before node_id was set.
    await admin`update forum_topics set node_id = null where id = ${ids.privateTopic}`;
    const res = await ex.exportForumArchive(anchor, { now: NOW });
    expect(res).toMatchObject({ status: 'done', exported: 1 });
    expect(await archivePages()).toHaveLength(4);
    const [t] = await admin<Row[]>`select node_id from forum_topics where id = ${ids.privateTopic}`;
    expect(t!.node_id).toBe(privatePageId);
  });
});
