/**
 * The work stamp's one module (A10 #7 fix round 2): what "a summary" is, in
 * JS and in SQL alike, and what a drop keeps. What the SQL does on a real
 * row is embed-work.db.test.ts's (server/api/src/agent/extract).
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  INDEX_WORK_KEYS,
  dropIndexWork,
  hasSummary,
  hasSummarySql,
  indexWorkSql,
  parseIndexWork,
  readIndexWork,
  stampHadVector,
  stampIndexWork,
} from './index-work';

const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q);

describe('hasSummary: an empty summary is no summary', () => {
  it.each([
    [{ summary: 'Pump overhaul.' }, true],
    [{ summary: '' }, false],
    [{ summary: ' \n\t ' }, false],
    [{ summary: 5 }, false],
    [{}, false],
    [null, false],
  ])('%j -> %s', (data, want) => {
    expect(hasSummary(data)).toBe(want);
  });

  it('in SQL: the same test, a string with something other than whitespace', () => {
    const q = render(hasSummarySql());
    expect(q.sql).toContain(`jsonb_typeof("nodes"."data"->'summary') = 'string'`);
    expect(q.sql).toContain(`btrim("nodes"."data"->>'summary', E' \\t\\n\\r\\f' || chr(11)) <> ''`);
    expect(q.sql).toMatch(/^coalesce\(/);
  });
});

describe('reading the stamp', () => {
  it('reads embed and extract, nothing else', () => {
    expect(readIndexWork({ index_work: 'embed' })).toBe('embed');
    expect(readIndexWork({ index_work: 'extract' })).toBe('extract');
    expect(readIndexWork({ index_work: 'later' })).toBeNull();
    expect(readIndexWork(null)).toBeNull();
  });

  it('reads the stamp in SQL as text, for the select that reads the row version (round 3, M1)', () => {
    const q = render(sql`select ${indexWorkSql(sql`d`)} as w`);
    expect(q.sql).toBe('select d->>$1::text as w');
    expect(q.params).toEqual(['index_work']);
    expect(parseIndexWork('extract')).toBe('extract');
    expect(parseIndexWork('embed')).toBe('embed');
    expect(parseIndexWork(null)).toBeNull();
    expect(parseIndexWork(undefined)).toBeNull();
  });

  it('had a vector: only with an embed stamp', () => {
    expect(stampHadVector({ index_work: 'embed', index_work_had_vector: true })).toBe(true);
    expect(stampHadVector({ index_work: 'extract', index_work_had_vector: true })).toBe(false);
    expect(stampHadVector({ index_work_had_vector: true })).toBe(false);
  });
});

describe('setting and dropping the stamp', () => {
  const drop = sql.raw(`array['summary']::text[]`);

  it('an embed reset keeps a waiting extract stamp and records a vector the row had', () => {
    const q = render(stampIndexWork('embed', drop));
    expect(q.sql).toMatch(
      /^case when coalesce\("nodes"\."data", '\{\}'::jsonb\)->>\$1::text = \$2 then/,
    );
    expect(q.params.slice(0, 2)).toEqual(['index_work', 'extract']);
    expect(q.sql).toContain(`"nodes"."embedding" is not null`);
    expect(q.params).toContain('index_work_had_vector');
  });

  it('an extract reset drops the summary keys and both stamp keys before stamping', () => {
    const q = render(stampIndexWork('extract', drop)).sql;
    expect(q).toContain(`array['summary']::text[]`);
    expect(q).toContain(`array['index_work', 'index_work_had_vector']::text[]`);
  });

  it('a drop removes both keys, and only while the stamp is still the one the job saw (L6)', () => {
    expect(INDEX_WORK_KEYS).toEqual(['index_work', 'index_work_had_vector']);
    const q = render(dropIndexWork(sql`d`, null));
    expect(q.sql).toContain(`->>$1::text is not distinct from $2::text`);
    expect(q.sql).toContain(`- array['index_work', 'index_work_had_vector']::text[] else`);
    expect(q.params).toEqual(['index_work', null]);
    expect(render(dropIndexWork(sql`d`, 'embed')).params).toEqual(['index_work', 'embed']);
  });
});
