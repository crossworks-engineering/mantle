/**
 * The per-agent Journal scope (journalVisibleSql) against a real Postgres:
 * operator precedence and NULLs are exactly what a pure test cannot see (the
 * first version hid rows through a NULL `source.via`). Runs on a TEMP table
 * named `nodes`, which shadows the real one for this connection only, so it
 * needs no migrated schema and leaves nothing behind.
 *
 * Gated on MANTLE_TEST_DATABASE_URL (any Postgres):
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/journal-scope.db.test.ts
 */
import { describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('journalVisibleSql on Postgres', () => {
  it('scopes learned rules to their agent; user facts, gaps and unowned rules stay brain-wide', async () => {
    process.env.DATABASE_URL = URL;
    const { db, closeDb } = await import('@mantle/db');
    const { sql } = await import('drizzle-orm');
    const { journalVisibleSql } = await import('./identity-context');
    try {
      const visible = await db.transaction(async (tx) => {
        await tx.execute(
          sql`create temp table nodes (id text, data jsonb, superseded_by uuid) on commit drop`,
        );
        await tx.execute(sql`insert into nodes (id, data, superseded_by) values
          ('own-lesson',       '{"kind":"lesson","agent_slug":"a"}', null),
          ('other-lesson',     '{"kind":"lesson","agent_slug":"b"}', null),
          ('unowned-lesson',   '{"kind":"lesson"}', null),
          ('blank-slug',       '{"kind":"expectation","agent_slug":"  "}', null),
          ('other-reflected',  '{"kind":"preference","agent_slug":"b","source":{"via":"reflector"}}', null),
          ('other-converted',  '{"kind":"identity","agent_slug":"b","source":{"persona_note_ref":"n1"}}', null),
          ('other-recorded',   '{"kind":"identity","agent_slug":"b","author":"agent"}', null),
          ('other-gap-answer', '{"kind":"context","agent_slug":"b","source":{"via":"resolve_gap"}}', null),
          ('other-gap',        '{"kind":"gap","agent_slug":"b"}', null),
          ('legacy-row',       '{"category":"family","body":"x"}', null),
          ('superseded',       '{"kind":"identity"}', '00000000-0000-4000-8000-000000000001')`);
        const rows = await tx.execute(
          sql`select id from nodes where ${journalVisibleSql('a')} order by id`,
        );
        return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
      });
      expect(visible).toEqual([
        'blank-slug',
        'legacy-row',
        'other-gap',
        'other-gap-answer',
        'other-recorded',
        'own-lesson',
        'unowned-lesson',
      ]);
    } finally {
      await closeDb();
    }
  });

  it('rule reconcile only ever sees live rules THIS agent learned', async () => {
    process.env.DATABASE_URL = URL;
    const { db, closeDb } = await import('@mantle/db');
    const { sql } = await import('drizzle-orm');
    const { learnedRuleOfAgentSql } = await import('./rule-reconcile');
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(
          sql`create temp table nodes (id text, data jsonb, superseded_by uuid) on commit drop`,
        );
        await tx.execute(sql`insert into nodes (id, data, superseded_by) values
          ('own-lesson',       '{"kind":"lesson","agent_slug":"a"}', null),
          ('own-padded-slug',  '{"kind":"expectation","agent_slug":" a "}', null),
          ('own-reflected',    '{"kind":"preference","agent_slug":"a","source":{"via":"reflector"}}', null),
          ('own-converted',    '{"kind":"identity","agent_slug":"a","source":{"persona_note_ref":"n1"}}', null),
          ('own-recorded',     '{"kind":"identity","agent_slug":"a","author":"agent"}', null),
          ('own-gap',          '{"kind":"gap","agent_slug":"a"}', null),
          ('own-context',      '{"kind":"context","agent_slug":"a","source":{"via":"reflector"}}', null),
          ('own-superseded',   '{"kind":"lesson","agent_slug":"a"}', '00000000-0000-4000-8000-000000000001'),
          ('other-lesson',     '{"kind":"lesson","agent_slug":"b"}', null),
          ('unowned-lesson',   '{"kind":"lesson"}', null),
          ('user-preference',  '{"kind":"preference","author":"user"}', null)`);
        const r = await tx.execute(
          sql`select id from nodes where ${learnedRuleOfAgentSql('a')} order by id`,
        );
        return (r as unknown as Array<{ id: string }>).map((x) => x.id);
      });
      expect(rows).toEqual(['own-converted', 'own-lesson', 'own-padded-slug', 'own-reflected']);
    } finally {
      await closeDb();
    }
  });
});
