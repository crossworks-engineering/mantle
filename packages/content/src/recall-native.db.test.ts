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

    it('keeps the published flag on the tree item, and the tree shows a draft', async () => {
      const made = await c.createRecallMap(
        owner,
        { title: 'Agent tree draft', enterWhen: 'Checking the tree' },
        AGENT,
      );
      const itemData = async () =>
        (
          (await m.db.execute(
            sqlTag`select data from nodes where id = ${made.mapId}`,
          )) as unknown as { data: Record<string, unknown> }[]
        )[0]!.data;
      const treeState = async () => {
        const { loadTreeFolder } = await import('./tree/read');
        const page = await loadTreeFolder(owner, 'recall');
        return page?.items.find((i) => i.id === made.mapId)?.state;
      };
      expect(await itemData()).toMatchObject({ enterWhen: 'Checking the tree', published: false });
      expect(await treeState()).toBe('draft');

      // An enter-when edit MERGES into the item's data: it must not wipe the
      // flag, which is what a plain replace of `data` did.
      const edited = await c.updateRecallMap(
        owner,
        made.mapId,
        { enterWhen: 'Checking the tree again', version: 1 },
        OWNER,
      );
      expect(await itemData()).toMatchObject({
        enterWhen: 'Checking the tree again',
        published: false,
      });

      await c.updateRecallMap(
        owner,
        made.mapId,
        { published: true, version: edited.version },
        OWNER,
      );
      expect(await itemData()).toMatchObject({
        enterWhen: 'Checking the tree again',
        published: true,
      });
      expect(await treeState()).toBeNull();
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

    it('a write to a leftover page-built (v1) row: retired in R5, not a map', async () => {
      const legacy = randomUUID();
      await m.db.execute(sqlTag`
        insert into recall_maps (id, owner_id, slug, title, enter_when, node_count, node_id)
        values (${legacy}, ${owner}, ${`v1-${tag}`}, 'V1 map', 'when', 1, null)`);
      await expect(
        c.putRecallCard(owner, legacy, null, { title: 'X', bodyMd: 'y' }, OWNER, 0),
      ).rejects.toMatchObject({ code: 'map_not_found' });
      // Nor can a native card lead to it, nor the card GET read it.
      await m.db.execute(sqlTag`
        insert into recall_nodes (id, owner_id, map_id, slug, kind, title, body_md)
        values (${legacy}, ${owner}, ${legacy}, 'start', 'index', 'V1 map', 'stale')`);
      expect(await c.getRecallCard(owner, legacy, 'start')).toBeNull();
      const map = await freshMap('Toward v1');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Toward v1',
            bodyMd: '',
            options: [{ label: 'Old', useWhen: 'never', targetSlug: 'x', targetMap: `v1-${tag}` }],
          },
          OWNER,
          map.version,
        ),
      ).rejects.toMatchObject({ code: 'cross_map_not_found' });
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

  describe('a restore keeps the card’s prompt state', () => {
    type Card = {
      title: string;
      body_md: string;
      use_when: string;
      kind: string;
      prompt_pending: boolean;
      options: unknown[];
      no_vec: boolean;
    };
    const card = async (mapId: string, slug: string) =>
      (
        (await m.db.execute(sqlTag`
          select title, body_md, use_when, kind, prompt_pending, options,
                 embedding is null as no_vec
            from recall_nodes where map_id = ${mapId} and slug = ${slug}`)) as unknown as Card[]
      )[0];
    const revision = async (mapId: string, summary: string) =>
      (await c.listRecallRevisions(owner, mapId)).find((r) => r.summary === summary)!;
    const version = async (mapId: string) => (await mapRow(mapId)).version;

    /** A map whose 'the-procedure' card an AGENT asked to be a prompt. It has
     *  an option, so a restore that blanked the card would show. */
    const requested = async (title: string) => {
      const map = await freshMap(title);
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Target', bodyMd: 't' },
        OWNER,
        map.version,
      );
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        {
          title: 'The procedure',
          bodyMd: 'steps',
          useWhen: 'doing the thing',
          prompt: true,
          options: [{ label: 'Then', useWhen: 'after', targetSlug: 'target' }],
        },
        AGENT,
        await version(map.mapId),
      );
      return map;
    };
    /** The card's content, unchanged from what `requested` wrote. */
    const expectContentKept = (got: Card | undefined) => {
      expect(got).toMatchObject({
        title: 'The procedure',
        body_md: 'steps',
        use_when: 'doing the thing',
      });
      expect(got!.options).toHaveLength(1);
    };

    it("undoing 'prompt confirmed' puts back only the pending request, not a blank card", async () => {
      const map = await requested('Undo confirm');
      await c.confirmRecallPrompt(
        owner,
        map.mapId,
        'the-procedure',
        true,
        OWNER,
        await version(map.mapId),
      );
      expect((await card(map.mapId, 'the-procedure'))!.kind).toBe('prompt');

      await c.restoreRecallRevision(
        owner,
        (await revision(map.mapId, 'prompt confirmed')).id,
        OWNER,
      );
      const back = await card(map.mapId, 'the-procedure');
      expectContentKept(back);
      expect(back).toMatchObject({ kind: 'knowledge', prompt_pending: true, no_vec: true });

      // And the restore is itself restorable: redo makes it a prompt again.
      await c.restoreRecallRevision(
        owner,
        (await revision(map.mapId, 'prompt state restored')).id,
        OWNER,
      );
      const redone = await card(map.mapId, 'the-procedure');
      expectContentKept(redone);
      expect(redone).toMatchObject({ kind: 'prompt', prompt_pending: false });
    });

    it("undoing 'prompt request dropped' puts the request back, content untouched", async () => {
      const map = await requested('Undo drop');
      await c.confirmRecallPrompt(
        owner,
        map.mapId,
        'the-procedure',
        false,
        OWNER,
        await version(map.mapId),
      );
      expect((await card(map.mapId, 'the-procedure'))!.prompt_pending).toBe(false);

      await c.restoreRecallRevision(
        owner,
        (await revision(map.mapId, 'prompt request dropped')).id,
        OWNER,
      );
      const back = await card(map.mapId, 'the-procedure');
      expectContentKept(back);
      expect(back).toMatchObject({ kind: 'knowledge', prompt_pending: true });
    });

    it('undoing a confirm on a card deleted since says to restore the delete first', async () => {
      const map = await requested('Confirm then delete');
      await c.confirmRecallPrompt(
        owner,
        map.mapId,
        'the-procedure',
        true,
        OWNER,
        await version(map.mapId),
      );
      await c.deleteRecallCard(owner, map.mapId, 'the-procedure', OWNER, await version(map.mapId));
      await expect(
        c.restoreRecallRevision(owner, (await revision(map.mapId, 'prompt confirmed')).id, OWNER),
      ).rejects.toThrow(/card deleted.*first/i);
    });

    it('the entry card cannot be confirmed as a prompt: recall_open starts there', async () => {
      const map = await freshMap('Entry stays entry');
      await expect(
        c.confirmRecallPrompt(owner, map.mapId, 'start', true, OWNER, map.version),
      ).rejects.toThrow(/entry card/i);
      expect((await card(map.mapId, 'start'))!.kind).toBe('index');
    });

    /** An owner-made prompt card, then an edit of its body. */
    const ownerPrompt = async (title: string) => {
      const map = await freshMap(title);
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Style', bodyMd: 'first', useWhen: 'writing prose', prompt: true },
        OWNER,
        map.version,
      );
      await c.putRecallCard(
        owner,
        map.mapId,
        'style',
        { title: 'Style', bodyMd: 'second', useWhen: 'writing prose', prompt: true },
        OWNER,
        await version(map.mapId),
      );
      return map;
    };

    it("undoing a 'card edited' keeps a prompt a prompt", async () => {
      const map = await ownerPrompt('Prompt edit undo');
      await c.restoreRecallRevision(owner, (await revision(map.mapId, 'card edited')).id, OWNER);
      const back = await card(map.mapId, 'style');
      // The text changed, so the vector is dropped for a refill: matchable
      // again in seconds, servable by slug now.
      expect(back).toMatchObject({ body_md: 'first', kind: 'prompt', no_vec: true });
    });

    it("undoing a 'card deleted' brings a prompt back as a prompt", async () => {
      const map = await ownerPrompt('Prompt delete undo');
      await c.deleteRecallCard(owner, map.mapId, 'style', OWNER, await version(map.mapId));
      await c.restoreRecallRevision(owner, (await revision(map.mapId, 'card deleted')).id, OWNER);
      expect(await card(map.mapId, 'style')).toMatchObject({
        body_md: 'second',
        kind: 'prompt',
        prompt_pending: false,
      });
    });

    it("the owner's undo of an agent's edit keeps a pending request pending, not confirmed", async () => {
      const map = await requested('Pending edit undo');
      await c.putRecallCard(
        owner,
        map.mapId,
        'the-procedure',
        { title: 'The procedure', bodyMd: 'more steps', useWhen: 'doing the thing', prompt: true },
        AGENT,
        await version(map.mapId),
      );
      await c.restoreRecallRevision(owner, (await revision(map.mapId, 'card edited')).id, OWNER);
      expect(await card(map.mapId, 'the-procedure')).toMatchObject({
        body_md: 'steps',
        kind: 'knowledge',
        prompt_pending: true,
      });
    });

    it('a revision written before the kind was recorded keeps the card as it is now', async () => {
      const map = await ownerPrompt('Legacy revision');
      const edit = await revision(map.mapId, 'card edited');
      await m.db.execute(sqlTag`
        update recall_revisions set before = before - 'kind' - 'promptPending'
         where id = ${edit.id}`);
      await c.restoreRecallRevision(owner, edit.id, OWNER);
      expect(await card(map.mapId, 'style')).toMatchObject({ body_md: 'first', kind: 'prompt' });
    });
  });

  // ── Audit 2026-09-30 fixes (page "AUDIT: Recall v2 (R1 to R3)") ───────────
  describe('audit fixes', () => {
    type Row = {
      slug: string;
      title: string;
      body_md: string;
      use_when: string;
      kind: string;
      rank: number;
      prompt_pending: boolean;
      options: { label: string; targetSlug: string; targetId?: string; targetMap?: string }[];
      former_slugs: string[];
      no_vec: boolean;
    };
    const rows = async (mapId: string) =>
      (await m.db.execute(sqlTag`
        select slug, title, body_md, use_when, kind, rank, prompt_pending, options,
               former_slugs, embedding is null as no_vec
          from recall_nodes where map_id = ${mapId} order by rank, slug`)) as unknown as Row[];
    const row = async (mapId: string, slug: string) =>
      (await rows(mapId)).find((r) => r.slug === slug);
    const v = async (mapId: string) => (await mapRow(mapId)).version;
    const revision = async (mapId: string, summary: string) =>
      (await c.listRecallRevisions(owner, mapId)).find((r) => r.summary === summary)!;
    /** A map with an owner-confirmed prompt card 'deploy'. */
    const withPrompt = async (title: string) => {
      const map = await freshMap(title);
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Deploy', bodyMd: 'do x', useWhen: 'deploying', prompt: true },
        OWNER,
        map.version,
      );
      return map;
    };

    it('H1: two writes sent from the same version cannot both commit', async () => {
      for (let i = 0; i < 6; i += 1) {
        const map = await freshMap(`Race ${i}`);
        const res = await Promise.allSettled([
          c.putRecallCard(owner, map.mapId, null, { title: 'A', bodyMd: 'a' }, OWNER, map.version),
          c.putRecallCard(owner, map.mapId, null, { title: 'B', bodyMd: 'b' }, OWNER, map.version),
        ]);
        const won = res.filter((r) => r.status === 'fulfilled');
        const lost = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(won).toHaveLength(1);
        expect(lost[0]!.reason).toMatchObject({ code: 'version_stale' });
        expect(await v(map.mapId)).toBe(2);
      }
    });

    it('H1: two creates with the same title get two slugs, not a raw error', async () => {
      const made = await Promise.all([
        c.createRecallMap(owner, { title: 'Same title', enterWhen: 'x' }, OWNER),
        c.createRecallMap(owner, { title: 'Same title', enterWhen: 'x' }, OWNER),
      ]);
      expect(made.map((x) => x.slug).sort()).toEqual(['same-title', 'same-title-2']);
    });

    /** Give the 'deploy' card a vector, so a test can see whether it is kept. */
    const embedDeploy = async (mapId: string) =>
      await m.db.execute(sqlTag`
        update recall_nodes
           set embedding = ${`[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`}::vector
         where map_id = ${mapId} and slug = 'deploy'`);

    it('H2: an agent edit that leaves the text alone keeps a confirmed prompt', async () => {
      const map = await withPrompt('Sticky agent');
      await c.putRecallCard(owner, map.mapId, null, { title: 'Next', bodyMd: '' }, OWNER, 2);
      await embedDeploy(map.mapId);
      // Options only: the words the owner approved are unchanged.
      await c.putRecallCard(
        owner,
        map.mapId,
        'deploy',
        {
          title: 'Deploy',
          bodyMd: 'do x',
          options: [{ label: 'Then', useWhen: 'after', targetSlug: 'next' }],
        },
        AGENT,
        await v(map.mapId),
      );
      expect(await row(map.mapId, 'deploy')).toMatchObject({
        kind: 'prompt',
        prompt_pending: false,
        use_when: 'deploying',
        no_vec: false,
      });
      // Trying to demote it changes nothing, and says so.
      const res = await c.putRecallCard(
        owner,
        map.mapId,
        'deploy',
        { title: 'Deploy', bodyMd: 'do x', prompt: false },
        AGENT,
        await v(map.mapId),
      );
      expect((await row(map.mapId, 'deploy'))!.kind).toBe('prompt');
      expect(res.warnings.map((w) => w.code)).toContain('prompt_kept');
    });

    it("N8: an agent changing a confirmed prompt's text sends it back for the owner to confirm", async () => {
      const map = await withPrompt('Reconfirm');
      await embedDeploy(map.mapId);
      const res = await c.putRecallCard(
        owner,
        map.mapId,
        'deploy',
        { title: 'Deploy', bodyMd: 'do x differently' },
        AGENT,
        await v(map.mapId),
      );
      // Pending, and without a vector: recall_match filters on kind 'prompt'
      // and a vector, so it stops finding the card.
      expect(await row(map.mapId, 'deploy')).toMatchObject({
        kind: 'knowledge',
        prompt_pending: true,
        no_vec: true,
        body_md: 'do x differently',
      });
      expect(res.warnings.map((w) => w.code)).toContain('prompt_needs_confirm');
      const rev = (await c.listRecallRevisions(owner, map.mapId))[0]!;
      expect(rev).toMatchObject({
        summary: 'prompt edited by agent, awaits confirm',
        actorKind: 'agent',
      });

      // The owner's undo puts back the old words AND the confirmed state.
      await c.restoreRecallRevision(owner, rev.id, OWNER);
      expect(await row(map.mapId, 'deploy')).toMatchObject({
        kind: 'prompt',
        prompt_pending: false,
        body_md: 'do x',
      });
    });

    it('N8: the owner confirming the edited prompt makes it matchable again', async () => {
      const bridge = await import('./embed-bridge');
      const recall = await import('./recall');
      const map = await withPrompt('Reconfirmed');
      await c.putRecallCard(
        owner,
        map.mapId,
        'deploy',
        { title: 'Deploy', bodyMd: 'do x again' },
        AGENT,
        await v(map.mapId),
      );
      await c.confirmRecallPrompt(owner, map.mapId, 'deploy', true, OWNER, await v(map.mapId));
      expect(await row(map.mapId, 'deploy')).toMatchObject({
        kind: 'prompt',
        prompt_pending: false,
      });
      const vec = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0));
      bridge.registerRecallEmbedder(async (_o, texts) => texts.map(() => vec));
      try {
        await recall.embedPendingRecallPrompts(owner);
        expect((await row(map.mapId, 'deploy'))!.no_vec).toBe(false);
      } finally {
        bridge.__resetRecallEmbedderForTests();
      }
    });

    it("N8: the owner's own text edit keeps a confirmed prompt confirmed", async () => {
      const map = await withPrompt('Owner edits');
      await c.putRecallCard(
        owner,
        map.mapId,
        'deploy',
        { title: 'Deploy', bodyMd: 'the owner rewrote it' },
        OWNER,
        await v(map.mapId),
      );
      expect(await row(map.mapId, 'deploy')).toMatchObject({
        kind: 'prompt',
        prompt_pending: false,
      });
      expect((await c.listRecallRevisions(owner, map.mapId))[0]!.summary).toBe('card edited');
    });

    it('H2: an owner save without the flag keeps a prompt, and keeps a pending request', async () => {
      const map = await withPrompt('Sticky owner');
      await c.putRecallCard(
        owner,
        map.mapId,
        'deploy',
        { title: 'Deploy', bodyMd: 'do y' },
        OWNER,
        await v(map.mapId),
      );
      expect((await row(map.mapId, 'deploy'))!.kind).toBe('prompt');

      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Asked', bodyMd: 'x', useWhen: 'when asked', prompt: true },
        AGENT,
        await v(map.mapId),
      );
      await c.putRecallCard(
        owner,
        map.mapId,
        'asked',
        { title: 'Asked', bodyMd: 'typo fixed' },
        OWNER,
        await v(map.mapId),
      );
      expect(await row(map.mapId, 'asked')).toMatchObject({
        kind: 'knowledge',
        prompt_pending: true,
        use_when: 'when asked',
      });
      // An explicit owner false is the deliberate drop.
      await c.putRecallCard(
        owner,
        map.mapId,
        'asked',
        { title: 'Asked', bodyMd: 'typo fixed', prompt: false },
        OWNER,
        await v(map.mapId),
      );
      expect((await row(map.mapId, 'asked'))!.prompt_pending).toBe(false);
    });

    it('H2: options left out are kept; sent, they replace', async () => {
      const map = await freshMap('Sticky options');
      await c.putRecallCard(owner, map.mapId, null, { title: 'Two', bodyMd: '' }, OWNER, 1);
      await c.putRecallCard(
        owner,
        map.mapId,
        'start',
        {
          title: 'Sticky options',
          bodyMd: '',
          options: [{ label: 'Go', useWhen: 'x', targetSlug: 'two' }],
        },
        OWNER,
        await v(map.mapId),
      );
      await c.putRecallCard(
        owner,
        map.mapId,
        'start',
        { title: 'Sticky options', bodyMd: 'intro' },
        AGENT,
        await v(map.mapId),
      );
      expect((await row(map.mapId, 'start'))!.options).toHaveLength(1);
      await c.putRecallCard(
        owner,
        map.mapId,
        'start',
        { title: 'Sticky options', bodyMd: 'intro', options: [] },
        OWNER,
        await v(map.mapId),
      );
      expect((await row(map.mapId, 'start'))!.options).toHaveLength(0);
    });

    it('M2: a deleted card comes back under its old slug, in its place, linked', async () => {
      const map = await freshMap('Undelete');
      let ver = map.version;
      for (const t of ['Fleet', 'Other']) {
        ver = (await c.putRecallCard(owner, map.mapId, null, { title: t, bodyMd: 'x' }, OWNER, ver))
          .version;
      }
      ver = (
        await c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Undelete',
            bodyMd: '',
            options: [
              { label: 'Fleet', useWhen: 'f', targetSlug: 'fleet' },
              { label: 'Other', useWhen: 'o', targetSlug: 'other' },
            ],
          },
          OWNER,
          ver,
        )
      ).version;
      ver = (
        await c.putRecallCard(
          owner,
          map.mapId,
          'fleet',
          { title: 'Fleet and boxes', bodyMd: 'x' },
          OWNER,
          ver,
        )
      ).version;
      await c.deleteRecallCard(owner, map.mapId, 'fleet', OWNER, ver);
      await c.restoreRecallRevision(owner, (await revision(map.mapId, 'card deleted')).id, OWNER);
      const all = await rows(map.mapId);
      // Back at rank 1, ahead of 'other', under its OLD slug (not the title's).
      expect(all.map((r) => r.slug)).toEqual(['start', 'fleet', 'other']);
      expect(all.find((r) => r.slug === 'fleet')!.rank).toBe(1);
      const start = all.find((r) => r.slug === 'start')!;
      expect(start.options.map((o) => o.targetSlug).sort()).toEqual(['fleet', 'other']);
    });

    it('M2: a reorder can be undone; "map created" says it cannot', async () => {
      const map = await freshMap('Undo order');
      let ver = map.version;
      for (const t of ['One', 'Two']) {
        ver = (await c.putRecallCard(owner, map.mapId, null, { title: t, bodyMd: '' }, OWNER, ver))
          .version;
      }
      await c.reorderRecallCards(owner, map.mapId, ['two', 'one'], OWNER, ver);
      await c.restoreRecallRevision(
        owner,
        (await revision(map.mapId, 'cards reordered')).id,
        OWNER,
      );
      expect((await rows(map.mapId)).map((r) => r.slug)).toEqual(['start', 'one', 'two']);
      await expect(
        c.restoreRecallRevision(owner, (await revision(map.mapId, 'map created')).id, OWNER),
      ).rejects.toMatchObject({ code: 'revision_not_restorable' });
    });

    it('M2: a slug change can be undone, and undoing a rename leaves later changes alone', async () => {
      const map = await freshMap('Undo slug');
      await c.updateRecallMap(owner, map.mapId, { title: 'Undo slug two', version: 1 }, OWNER);
      await c.updateRecallMap(owner, map.mapId, { published: false, version: 2 }, OWNER);
      await c.updateRecallMap(owner, map.mapId, { slug: 'moved', version: 3 }, OWNER);
      await c.restoreRecallRevision(owner, (await revision(map.mapId, 'slug changed')).id, OWNER);
      let got = await mapRow(map.mapId);
      expect(got.slug).toBe('undo-slug');
      expect(got.former_slugs).toEqual(['moved']);
      await c.restoreRecallRevision(owner, (await revision(map.mapId, 'renamed')).id, OWNER);
      got = await mapRow(map.mapId);
      // The rename is undone; the later unpublish is not.
      expect(got).toMatchObject({ title: 'Undo slug', published: false });
    });

    it('M2: a no-op patch writes no revision and keeps the version', async () => {
      const map = await freshMap('Quiet');
      const res = await c.updateRecallMap(
        owner,
        map.mapId,
        { title: 'Quiet', slug: 'Quiet', version: 1 },
        OWNER,
      );
      expect(res.version).toBe(1);
      expect((await mapRow(map.mapId)).former_slugs).toEqual([]);
      expect((await c.listRecallRevisions(owner, map.mapId)).map((r) => r.summary)).toEqual([
        'map created',
      ]);
    });

    it('M4: an option to a map that went away is reported', async () => {
      const target = await freshMap('Gone target');
      const from = await freshMap('Still pointing');
      await c.putRecallCard(
        owner,
        from.mapId,
        'start',
        {
          title: 'Still pointing',
          bodyMd: '',
          options: [
            { label: 'Go', useWhen: 'x', targetSlug: 'gone-target', targetMap: 'gone-target' },
          ],
        },
        OWNER,
        from.version,
      );
      await c.deleteRecallMap(owner, target.mapId, OWNER);
      const res = await c.putRecallCard(
        owner,
        from.mapId,
        'start',
        { title: 'Still pointing', bodyMd: 'x' },
        OWNER,
        await v(from.mapId),
      );
      expect(res.warnings.map((w) => w.code)).toContain('cross_map_target_gone');
    });

    it('M5: a revision keeps the actor name', async () => {
      const map = await freshMap('Named');
      await c.putRecallCard(owner, map.mapId, null, { title: 'X', bodyMd: '' }, AGENT, 1);
      const revs = await c.listRecallRevisions(owner, map.mapId);
      expect(revs[0]).toMatchObject({ actorKind: 'agent', actorName: 'librarian' });
      expect(revs.at(-1)).toMatchObject({ actorKind: 'owner', actorName: 'Owner' });
    });

    it('M6: a former map slug is not given to another map', async () => {
      const map = await freshMap('Remembered');
      await c.updateRecallMap(owner, map.mapId, { slug: 'remembered-now', version: 1 }, OWNER);
      const other = await freshMap('Remembered');
      expect(other.slug).not.toBe('remembered');
      await expect(
        c.updateRecallMap(owner, other.mapId, { slug: 'remembered', version: 1 }, OWNER),
      ).rejects.toMatchObject({ code: 'slug_taken' });
    });

    it('M6: a card slug change keeps the old slug, and options follow the card', async () => {
      const map = await freshMap('Card slugs');
      await c.putRecallCard(owner, map.mapId, null, { title: 'Box', bodyMd: '' }, OWNER, 1);
      await c.putRecallCard(
        owner,
        map.mapId,
        'start',
        {
          title: 'Card slugs',
          bodyMd: '',
          options: [{ label: 'Box', useWhen: 'x', targetSlug: 'box' }],
        },
        OWNER,
        await v(map.mapId),
      );
      await c.putRecallCard(
        owner,
        map.mapId,
        'box',
        { title: 'Box', bodyMd: '', slug: 'box-by-box' },
        OWNER,
        await v(map.mapId),
      );
      expect((await row(map.mapId, 'box-by-box'))!.former_slugs).toEqual(['box']);
      expect((await row(map.mapId, 'start'))!.options[0]!.targetSlug).toBe('box-by-box');
      expect((await c.getRecallCard(owner, map.mapId, 'box'))!.slug).toBe('box-by-box');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'box-by-box',
          { title: 'Box', bodyMd: '', slug: 'again' },
          AGENT,
          await v(map.mapId),
        ),
      ).rejects.toMatchObject({ code: 'slug_is_owners' });
    });

    it('L2: a reorder must name every card exactly once', async () => {
      const map = await freshMap('Whole order');
      let ver = map.version;
      for (const t of ['A', 'B', 'C']) {
        ver = (await c.putRecallCard(owner, map.mapId, null, { title: t, bodyMd: '' }, OWNER, ver))
          .version;
      }
      await expect(c.reorderRecallCards(owner, map.mapId, ['c'], OWNER, ver)).rejects.toMatchObject(
        { code: 'reorder_incomplete' },
      );
      await expect(
        c.reorderRecallCards(owner, map.mapId, ['a', 'a', 'b', 'c'], OWNER, ver),
      ).rejects.toMatchObject({ code: 'reorder_incomplete' });
      await c.reorderRecallCards(owner, map.mapId, ['start', 'c', 'b', 'a'], OWNER, ver);
      expect((await rows(map.mapId)).map((r) => `${r.slug}@${r.rank}`)).toEqual([
        'start@0',
        'c@1',
        'b@2',
        'a@3',
      ]);
    });

    it('L5 and more refusals: folder, after, map_full, owner-only delete', async () => {
      await expect(
        c.createRecallMap(owner, { title: 'Filed', enterWhen: 'x', folder: 'Nope' }, OWNER),
      ).rejects.toMatchObject({ code: 'folder_not_found' });
      const map = await freshMap('Refusals');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          null,
          { title: 'X', bodyMd: '', after: 'nope' },
          OWNER,
          1,
        ),
      ).rejects.toMatchObject({ code: 'after_not_found' });
      await expect(c.deleteRecallMap(owner, map.mapId, AGENT)).rejects.toMatchObject({
        code: 'delete_is_owners',
      });
      await m.db.execute(sqlTag`
        insert into recall_nodes (owner_id, map_id, slug, kind, title, rank)
        select ${owner}, ${map.mapId}, 'filler-' || g, 'knowledge', 'Filler', g
          from generate_series(1, 99) g`);
      await expect(
        c.putRecallCard(owner, map.mapId, null, { title: 'One more', bodyMd: '' }, OWNER, 1),
      ).rejects.toMatchObject({ code: 'map_full' });
    });

    it('L9: a new card that links to itself carries its own id', async () => {
      const map = await freshMap('Self link');
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        {
          title: 'Loop',
          bodyMd: '',
          options: [{ label: 'Again', useWhen: 'x', targetSlug: 'loop' }],
        },
        OWNER,
        1,
      );
      const loop = await c.getRecallCard(owner, map.mapId, 'loop');
      expect(loop!.options![0]!.targetId).toBe(loop!.id);
    });

    it('M7: the embed refill fills a prompt, and never onto text that changed under it', async () => {
      const bridge = await import('./embed-bridge');
      const recall = await import('./recall');
      const vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
      const map = await withPrompt('Embedded');
      bridge.registerRecallEmbedder(async (_o, texts) => texts.map(() => vec));
      try {
        await recall.embedPendingRecallPrompts(owner);
        expect((await row(map.mapId, 'deploy'))!.no_vec).toBe(false);

        // An edit lands while the embed is in flight: that vector is for the
        // old text, so it must not be written.
        await m.db.execute(sqlTag`
          update recall_nodes set embedding = null where map_id = ${map.mapId} and slug = 'deploy'`);
        bridge.registerRecallEmbedder(async (_o, texts) => {
          await m.db.execute(sqlTag`
            update recall_nodes set body_md = 'changed' where map_id = ${map.mapId} and slug = 'deploy'`);
          return texts.map(() => vec);
        });
        await recall.embedPendingRecallPrompts(owner);
        expect((await row(map.mapId, 'deploy'))!.no_vec).toBe(true);
      } finally {
        bridge.__resetRecallEmbedderForTests();
      }
    });

    // ── second audit (session "Recall and folder systems audit") ────────────

    it('N5: undoing "card added" never deletes a newer card that took the slug', async () => {
      const map = await freshMap('Reused slug');
      const add = await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Fleet', bodyMd: 'old' },
        OWNER,
        1,
      );
      const firstAdd = (await c.listRecallRevisions(owner, map.mapId)).find(
        (r) => r.summary === 'card added',
      )!;
      const del = await c.deleteRecallCard(owner, map.mapId, 'fleet', OWNER, add.version);
      await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Fleet', bodyMd: 'new' },
        OWNER,
        del.version,
      );
      await expect(c.restoreRecallRevision(owner, firstAdd.id, OWNER)).rejects.toMatchObject({
        code: 'card_not_found',
      });
      expect((await row(map.mapId, 'fleet'))!.body_md).toBe('new');
    });

    it('N6: caps on lines and options, and an option needs its use-when', async () => {
      await expect(
        c.createRecallMap(owner, { title: 'Capped', enterWhen: 'x'.repeat(501) }, OWNER),
      ).rejects.toMatchObject({ code: 'too_long' });
      const map = await freshMap('Capped options');
      await c.putRecallCard(owner, map.mapId, null, { title: 'Two', bodyMd: '' }, OWNER, 1);
      const ver = await v(map.mapId);
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Capped options',
            bodyMd: '',
            options: [{ label: 'Go', useWhen: ' ', targetSlug: 'two' }],
          },
          OWNER,
          ver,
        ),
      ).rejects.toMatchObject({ code: 'option_use_when_required' });
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Capped options',
            bodyMd: '',
            options: Array.from({ length: 31 }, (_, i) => ({
              label: `Go ${i}`,
              useWhen: 'x',
              targetSlug: 'two',
            })),
          },
          OWNER,
          ver,
        ),
      ).rejects.toMatchObject({ code: 'too_many_options' });
    });

    it('refuses a cross-map option to a map that does not exist, naming recall_index', async () => {
      const map = await freshMap('Nowhere to go');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'start',
          {
            title: 'Nowhere to go',
            bodyMd: '',
            options: [{ label: 'Go', useWhen: 'x', targetSlug: 'no-map', targetMap: 'no-map' }],
          },
          OWNER,
          1,
        ),
      ).rejects.toMatchObject({
        code: 'cross_map_not_found',
        message: expect.stringContaining('recall_index lists the maps'),
      });
      // Refused means nothing written: the version did not move.
      expect(await v(map.mapId)).toBe(1);
    });

    it('N11: no card can take the slug the reorder route owns', async () => {
      const map = await freshMap('Reserved');
      const res = await c.putRecallCard(
        owner,
        map.mapId,
        null,
        { title: 'Reorder', bodyMd: '' },
        OWNER,
        1,
      );
      expect(res.cardSlug).toBe('reorder-2');
      await expect(
        c.putRecallCard(
          owner,
          map.mapId,
          'reorder-2',
          { title: 'Reorder', bodyMd: '', slug: 'reorder' },
          OWNER,
          res.version,
        ),
      ).rejects.toMatchObject({ code: 'slug_reserved' });
    });

    it('M6: a cross-map option to a former slug is stored under the slug now', async () => {
      const target = await freshMap('Moved target');
      await c.updateRecallMap(owner, target.mapId, { slug: 'moved-target-now', version: 1 }, OWNER);
      const from = await freshMap('Moved source');
      await c.putRecallCard(
        owner,
        from.mapId,
        'start',
        {
          title: 'Moved source',
          bodyMd: '',
          options: [
            { label: 'Go', useWhen: 'x', targetSlug: 'moved-target', targetMap: 'moved-target' },
          ],
        },
        OWNER,
        1,
      );
      expect((await row(from.mapId, 'start'))!.options[0]).toMatchObject({
        targetMap: 'moved-target-now',
        targetSlug: 'moved-target-now',
      });
    });

    it('keeps the tree item fresh: a card write moves the map item updated_at', async () => {
      const map = await freshMap('Fresh item');
      await m.db.execute(sqlTag`
        update nodes set updated_at = now() - interval '1 day' where id = ${map.mapId}`);
      await c.putRecallCard(owner, map.mapId, null, { title: 'X', bodyMd: '' }, OWNER, 1);
      const [item] = (await m.db.execute(sqlTag`
        select updated_at > now() - interval '1 minute' as fresh from nodes where id = ${map.mapId}`)) as unknown as {
        fresh: boolean;
      }[];
      expect(item!.fresh).toBe(true);
    });

    it('files a map in a folder whose title has a slash', async () => {
      await m.db.execute(sqlTag`
        insert into nodes (owner_id, type, title, slug, path)
        values (${owner}, 'branch', 'CI/CD', 'ci_cd', 'recall.ci_cd'::ltree)
        on conflict do nothing`);
      const made = await c.createRecallMap(
        owner,
        { title: 'Pipelines', enterWhen: 'x', folder: 'CI/CD' },
        OWNER,
      );
      const [item] = (await m.db.execute(sqlTag`
        select path::text as path from nodes where id = ${made.mapId}`)) as unknown as {
        path: string;
      }[];
      expect(item!.path).toBe('recall.ci_cd');
    });

    it('logs the owner turning a confirmed prompt off as a demotion', async () => {
      const map = await withPrompt('Demoted');
      await c.confirmRecallPrompt(owner, map.mapId, 'deploy', false, OWNER, await v(map.mapId));
      expect((await c.listRecallRevisions(owner, map.mapId))[0]!.summary).toBe('prompt demoted');
      expect((await row(map.mapId, 'deploy'))!.kind).toBe('knowledge');
    });
  });
});
