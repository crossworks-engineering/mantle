/**
 * The Recall v2 native write path, against a real migrated Postgres.
 *
 * What this file is really about is the MOMENT the checks run. v1 compiled
 * pages into the serving rows and linted afterwards, so a broken edit
 * published anyway and the map went on serving its last good revision with a
 * note on every agent read — which is how the dev brain's registry served a
 * two-week-old revision without anyone noticing. v2 refuses the write instead,
 * so each refusal below is a behaviour the design depends on, not a nicety.
 *
 * Every refusal is also checked for its RECOVERY, because an error that only
 * says "no" sends an agent into a retry loop.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/recall-native.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('Recall v2 native writes, on Postgres', () => {
  type Content = typeof import('./recall-native');
  type Db = typeof import('@mantle/db');
  let c: Content;
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;

  const owner = randomUUID();
  const tag = `recall-native-${owner.slice(0, 8)}`;
  const OWNER = { kind: 'owner' as const, id: owner, name: 'Owner' };
  const AGENT = { kind: 'agent' as const, id: randomUUID(), name: 'librarian' };

  /** A fresh map per test, so one test's refusal cannot explain another's. */
  const freshMap = async (title = 'Fleet and access') => {
    const made = await c.createRecallMap(
      owner,
      { title, enterWhen: 'Working on the fleet' },
      OWNER,
    );
    return made;
  };
  const cardsOf = async (mapId: string) =>
    (await m.db.execute(sqlTag`
      select slug, kind, rank, prompt_pending, options, body_chars, embedding is null as no_vec
        from recall_nodes where map_id = ${mapId} order by rank`)) as unknown as {
      slug: string;
      kind: string;
      rank: number;
      prompt_pending: boolean;
      options: { label: string; targetSlug: string; targetMap?: string }[];
      body_chars: number;
      no_vec: boolean;
    }[];
  const mapRow = async (mapId: string) =>
    (
      (await m.db.execute(sqlTag`
        select slug, title, version, node_count, published, former_slugs
          from recall_maps where id = ${mapId}`)) as unknown as {
        slug: string;
        title: string;
        version: number;
        node_count: number;
        published: boolean;
        former_slugs: string[];
      }[]
    )[0]!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ sql: sqlTag } = await import('drizzle-orm'));
    c = await import('./recall-native');
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
  });

  afterAll(async () => {
    if (!URL) return;
    await m.db.execute(sqlTag`delete from recall_revisions where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_maps where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  describe('creating a map', () => {
    it('gives it an entry card, a slug and a counted card', async () => {
      const made = await freshMap('Running Mantle');
      expect(made.slug).toBe('running-mantle');
      const row = await mapRow(made.mapId);
      // node_count matters more than it looks: recall_index hides a map at 0,
      // so a native map that never maintained it is invisible to every agent.
      expect(row.node_count).toBe(1);
      expect(row.published).toBe(true);
      const cards = await cardsOf(made.mapId);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ slug: 'start', kind: 'index' });
    });

    it("leaves an AGENT's map unpublished, for the owner to publish", async () => {
      const made = await c.createRecallMap(
        owner,
        { title: 'Agent idea', enterWhen: 'Never, yet' },
        AGENT,
      );
      expect(made.published).toBe(false);
      expect((await mapRow(made.mapId)).published).toBe(false);
    });

    it('refuses a map with no enter-when, and says what it is for', async () => {
      await expect(
        c.createRecallMap(owner, { title: 'Nameless', enterWhen: '  ' }, OWNER),
      ).rejects.toThrow(/enter when.*recall_index|recall_index.*enter/is);
    });

    it('cuts a long slug at a word boundary, not mid-word', async () => {
      const slug = c.recallNativeSlug(
        'Registry 2b access gaps alias coverage and the connector fallback path',
      );
      expect(slug.length).toBeLessThanOrEqual(60);
      // The v1 slugger produced '…-and-the-connector-fal'.
      expect(slug.endsWith('-')).toBe(false);
      expect(slug).not.toMatch(/fal$/);
    });
  });

  describe('the checks refuse, and each says the fix', () => {
    it('a body over budget: split it into a second card', async () => {
      const map = await freshMap('Budget');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          null,
          { title: 'Too long', bodyMd: 'x'.repeat(6001) },
          OWNER,
          map.version,
        ),
      ).rejects.toThrow(/6001 characters.*6000.*[Ss]plit it/s);
      // And nothing was written.
      expect(await cardsOf(map.mapId)).toHaveLength(1);
    });

    it('a prompt with no use-when: recall_match has nothing to compare', async () => {
      const map = await freshMap('Promptless');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          null,
          { title: 'A prompt', bodyMd: 'do the thing', prompt: true },
          OWNER,
          map.version,
        ),
      ).rejects.toThrow(/use when.*recall_match|recall_match.*use when/is);
    });

    it('an option to a card that is not there: lists the cards, suggests a near miss', async () => {
      const map = await freshMap('Dangling');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Box by box', bodyMd: 'one line per box' },
        OWNER,
        map.version,
      );
      const v = (await mapRow(map.mapId)).version;
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Dangling',
            bodyMd: '',
            options: [{ label: 'Go', useWhen: 'always', targetSlug: 'box-by-bo' }],
          },
          OWNER,
          v,
        ),
      ).rejects.toThrow(/did you mean 'box-by-box'/i);
    });

    it('a cross-map option to an unpublished map: no agent could follow it', async () => {
      const map = await freshMap('Crosser');
      const hidden = await c.createRecallMap(owner, { title: 'Hidden', enterWhen: 'Never' }, AGENT);
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Crosser',
            bodyMd: '',
            options: [
              { label: 'Over there', useWhen: 'later', targetSlug: 'x', targetMap: hidden.slug },
            ],
          },
          OWNER,
          map.version,
        ),
      ).rejects.toThrow(/not published yet.*[Pp]ublish that map first/s);
    });

    it('a stale version: re-read, re-apply, send the new one', async () => {
      const map = await freshMap('Concurrent');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'First', bodyMd: 'a' },
        OWNER,
        map.version,
      );
      // Second writer still holding the version it read before that write.
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          null,
          { title: 'Second', bodyMd: 'b' },
          OWNER,
          map.version,
        ),
      ).rejects.toThrow(/changed since you read it.*[Rr]e-read/s);
    });

    it('no version at all, rather than assuming the write is safe', async () => {
      const map = await freshMap('Versionless');
      await expect(
        c.putRecallCard(owner, map.mapId, null, { title: 'X', bodyMd: 'y' }, OWNER),
      ).rejects.toThrow(/needs the map's current version/i);
    });

    it('deleting the entry card: every walk starts there', async () => {
      const map = await freshMap('Entry');
      await expect(
        c.deleteRecallCard(owner, map.mapId, 'start', OWNER, map.version),
      ).rejects.toThrow(/entry card.*delete the map instead/s);
    });

    it('a write to a page-built (v1) map: its pages are its source', async () => {
      const legacy = randomUUID();
      await m.db.execute(sqlTag`
        insert into recall_maps (id, owner_id, slug, title, enter_when, node_count, node_id)
        values (${legacy}, ${owner}, ${`v1-${tag}`}, 'V1 map', 'when', 1, null)`);
      await expect(
        c.putRecallCard(owner, legacy, null, { title: 'X', bodyMd: 'y' }, OWNER, 0),
      ).rejects.toThrow(/page-built.*Edit its pages/s);
    });
  });

  describe('prompts stay the owner’s act', () => {
    it('an agent asking only records the request, and it cannot match', async () => {
      const map = await freshMap('Prompted');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'The procedure', bodyMd: 'steps', useWhen: 'doing the thing', prompt: true },
        AGENT,
        map.version,
      );
      const card = (await cardsOf(map.mapId)).find((x) => x.slug === 'the-procedure')!;
      // Pending, and NOT kind 'prompt' — so it is outside the partial index
      // recall_match probes, and no vector was minted for it.
      expect(card.prompt_pending).toBe(true);
      expect(card.kind).toBe('knowledge');
      expect(card.no_vec).toBe(true);
    });

    it('the owner confirming makes it a prompt and queues its vector', async () => {
      const map = await freshMap('Confirmed');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'The procedure', bodyMd: 'steps', useWhen: 'doing the thing', prompt: true },
        AGENT,
        map.version,
      );
      const v = (await mapRow(map.mapId)).version;
      await c.confirmRecallPrompt(owner, map.mapId, 'the-procedure', true, OWNER, v);
      const card = (await cardsOf(map.mapId)).find((x) => x.slug === 'the-procedure')!;
      expect(card.kind).toBe('prompt');
      expect(card.prompt_pending).toBe(false);
    });

    it('an agent cannot confirm, and cannot publish', async () => {
      const map = await freshMap('Gatekeeping');
      await expect(
        c.confirmRecallPrompt(owner, map.mapId, 'start', true, AGENT, map.version),
      ).rejects.toThrow(/[Oo]nly the owner confirms/);
      await expect(
        c.updateRecallMap(owner, map.mapId, { published: true, version: map.version }, AGENT),
      ).rejects.toThrow(/owner's call/i);
    });
  });

  describe('edits that have to stay consistent', () => {
    it('deleting a card removes the options pointing at it, and says which', async () => {
      const map = await freshMap('Consistent');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Detail', bodyMd: 'detail' },
        OWNER,
        map.version,
      );
      let v = (await mapRow(map.mapId)).version;
      await c.putRecallCard(
        owner,
        map.mapId,
        'start',
        {
          title: 'Consistent',
          bodyMd: '',
          options: [{ label: 'The detail', useWhen: 'you need it', targetSlug: 'detail' }],
        },
        OWNER,
        v,
      );
      v = (await mapRow(map.mapId)).version;
      const res = await c.deleteRecallCard(owner, map.mapId, 'detail', OWNER, v);
      expect(res.optionsDropped).toEqual([{ cardSlug: 'start', label: 'The detail' }]);
      const entry = (await cardsOf(map.mapId)).find((x) => x.slug === 'start')!;
      expect(entry.options).toEqual([]);
    });

    it('a rename keeps the slug; an explicit slug change keeps the old one resolving', async () => {
      const map = await freshMap('Renamed');
      await c.updateRecallMap(
        owner,
        map.mapId,
        { title: 'Quite different', version: map.version },
        OWNER,
      );
      let row = await mapRow(map.mapId);
      expect(row.slug).toBe('renamed');
      expect(row.title).toBe('Quite different');

      await c.updateRecallMap(
        owner,
        map.mapId,
        { slug: 'quite-different', version: row.version },
        OWNER,
      );
      row = await mapRow(map.mapId);
      expect(row.slug).toBe('quite-different');
      expect(row.former_slugs).toContain('renamed');
    });

    it('a slug change rewrites the cross-map options that pointed at it', async () => {
      const target = await freshMap('Target map');
      const from = await freshMap('Pointing map');
      await c.putRecallCard(
        owner,
        from.mapId,
        'start',
        {
          title: 'Pointing map',
          bodyMd: '',
          options: [{ label: 'Over', useWhen: 'later', targetSlug: 'x', targetMap: 'target-map' }],
        },
        OWNER,
        from.version,
      );
      await c.updateRecallMap(
        owner,
        target.mapId,
        { slug: 'renamed-target', version: (await mapRow(target.mapId)).version },
        OWNER,
      );
      const entry = (await cardsOf(from.mapId)).find((x) => x.slug === 'start')!;
      expect(entry.options[0]).toMatchObject({
        targetMap: 'renamed-target',
        targetSlug: 'renamed-target',
      });
    });

    it('warns about an orphan card without blocking it', async () => {
      const map = await freshMap('Orphanage');
      const res = await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Nobody links here', bodyMd: 'x' },
        OWNER,
        map.version,
      );
      // Non-blocking on purpose: you must be able to add card two before you
      // edit card one to point at it.
      expect(res.cardSlug).toBe('nobody-links-here');
      expect(res.warnings.map((w) => w.code)).toContain('orphan_card');
    });

    it('keeps node_count in step, so the catalog can see the map', async () => {
      const map = await freshMap('Counted');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Two', bodyMd: 'x' },
        OWNER,
        map.version,
      );
      expect((await mapRow(map.mapId)).node_count).toBe(2);
      const v = (await mapRow(map.mapId)).version;
      await c.deleteRecallCard(owner, map.mapId, 'two', OWNER, v);
      expect((await mapRow(map.mapId)).node_count).toBe(1);
    });

    it('records a revision per write, naming the actor', async () => {
      const map = await freshMap('Audited');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Edit', bodyMd: 'x' },
        AGENT,
        map.version,
      );
      const revs = await c.listRecallRevisions(owner, map.mapId);
      expect(revs[0]).toMatchObject({ actorKind: 'agent', summary: 'card added' });
      expect(revs.at(-1)).toMatchObject({ actorKind: 'owner', summary: 'map created' });
    });

    it('restores an edited card to what it was', async () => {
      const map = await freshMap('Undoable');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Card', bodyMd: 'first' },
        OWNER,
        map.version,
      );
      const v = (await mapRow(map.mapId)).version;
      await c.putRecallCard(
        owner,
        map.mapId,
        'card',
        { title: 'Card', bodyMd: 'second' },
        OWNER,
        v,
      );

      // The revision for the EDIT carries the pre-edit body.
      const revs = await c.listRecallRevisions(owner, map.mapId);
      const edit = revs.find((r) => r.summary === 'card edited' && r.cardSlug === 'card')!;
      await c.restoreRecallRevision(owner, edit.id, OWNER);
      const rows = (await m.db.execute(sqlTag`
        select body_md from recall_nodes where map_id = ${map.mapId} and slug = 'card'`)) as unknown as {
        body_md: string;
      }[];
      expect(rows[0]!.body_md).toBe('first');
    });

    it('restoring a card ADDITION removes the card again', async () => {
      const map = await freshMap('Undo add');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Added', bodyMd: 'x' },
        OWNER,
        map.version,
      );
      const revs = await c.listRecallRevisions(owner, map.mapId);
      const added = revs.find((r) => r.summary === 'card added')!;
      await c.restoreRecallRevision(owner, added.id, OWNER);
      expect((await cardsOf(map.mapId)).map((x) => x.slug)).not.toContain('added');
    });

    it('brings a DELETED card back, with its slug', async () => {
      const map = await freshMap('Undo delete');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Gone', bodyMd: 'body' },
        OWNER,
        map.version,
      );
      const v = (await mapRow(map.mapId)).version;
      await c.deleteRecallCard(owner, map.mapId, 'gone', OWNER, v);
      const revs = await c.listRecallRevisions(owner, map.mapId);
      const del = revs.find((r) => r.summary === 'card deleted')!;
      await c.restoreRecallRevision(owner, del.id, OWNER);
      const back = (await cardsOf(map.mapId)).find((x) => x.slug === 'gone');
      expect(back).toBeDefined();
    });

    it('restores a map rename', async () => {
      const map = await freshMap('Old title');
      await c.updateRecallMap(
        owner,
        map.mapId,
        { title: 'New title', version: map.version },
        OWNER,
      );
      const revs = await c.listRecallRevisions(owner, map.mapId);
      const renamed = revs.find((r) => r.summary === 'renamed')!;
      await c.restoreRecallRevision(owner, renamed.id, OWNER);
      expect((await mapRow(map.mapId)).title).toBe('Old title');
    });

    it('a restore runs the checks, so it cannot reinstate a broken map', async () => {
      // The card being restored pointed at a card that has since gone. The
      // restore is refused rather than putting a dead option back.
      const map = await freshMap('Checked restore');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Target', bodyMd: 't' },
        OWNER,
        map.version,
      );
      let v = (await mapRow(map.mapId)).version;
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        {
          title: 'Pointer',
          bodyMd: 'p',
          options: [{ label: 'On', useWhen: 'later', targetSlug: 'target' }],
        },
        OWNER,
        v,
      );
      v = (await mapRow(map.mapId)).version;
      // Edit the pointer (this revision's BEFORE still names 'target') ...
      await c.putRecallCard(
        owner,
        map.mapId,
        'pointer',
        { title: 'Pointer', bodyMd: 'p2' },
        OWNER,
        v,
      );
      v = (await mapRow(map.mapId)).version;
      // ... then delete the target.
      await c.deleteRecallCard(owner, map.mapId, 'target', OWNER, v);

      const revs = await c.listRecallRevisions(owner, map.mapId);
      const edit = revs.find((r) => r.summary === 'card edited' && r.cardSlug === 'pointer')!;
      await expect(c.restoreRecallRevision(owner, edit.id, OWNER)).rejects.toThrow(
        /not in this map/i,
      );
    });

    it('is the owner’s act, not an agent’s', async () => {
      const map = await freshMap('Owner only');
      const revs = await c.listRecallRevisions(owner, map.mapId);
      await expect(c.restoreRecallRevision(owner, revs[0]!.id, AGENT)).rejects.toThrow(
        /owner's act/i,
      );
    });

    it('deleting the map takes its cards and its revisions with it', async () => {
      const map = await freshMap('Doomed');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Card', bodyMd: 'x' },
        OWNER,
        map.version,
      );
      await c.deleteRecallMap(owner, map.mapId, OWNER);
      expect(await cardsOf(map.mapId)).toHaveLength(0);
      const rows = (await m.db.execute(sqlTag`
        select count(*)::int as n from recall_maps where id = ${map.mapId}`)) as unknown as {
        n: number;
      }[];
      expect(rows[0]!.n).toBe(0);
    });
  });
});
