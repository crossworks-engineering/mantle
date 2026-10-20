/**
 * graphPath's walk text (graphPathSql) goes through readSql, which throws
 * for text that is not one statement that reads. Every relation verb is
 * inlined in a string literal, so a verb that spells a write, a keyword or
 * a function readSql refuses (nextval, setval, pg_notify) is a value there
 * and the walk still reads.
 */
import { readSql } from '@mantle/db';
import { describe, expect, it } from 'vitest';
import { graphPathSql } from './entities';

const FROM = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';
const TO = '00000000-0000-4000-8000-000000000003';

// Verbs as the extractor writes them, then verbs that spell SQL readSql
// refuses as code.
const VERBS = [
  'employed_by',
  'works_at',
  'supplies',
  'located_in',
  'part_of',
  'married_to',
  'nextval',
  'setval',
  'pg_notify',
  'set_config',
  'pg_advisory_lock',
  'lo_import',
  'dblink_exec',
  'delete',
  'update',
  'insert',
  'merge',
  'into',
  'for_update',
  'copy',
  'grant',
  'select',
];

describe('graphPathSql', () => {
  it('reads with every option and every verb', () => {
    for (const directed of [true, false]) {
      for (const toId of [undefined, TO]) {
        for (const relations of [undefined, VERBS, ...VERBS.map((v) => [v])]) {
          const text = graphPathSql({
            fromId: FROM,
            ownerId: OWNER,
            toId,
            directed,
            relations,
            maxDepth: 4,
            limit: 20,
          });
          expect(readSql(text)).toBe(text);
        }
      }
    }
  });

  it('reduces a verb to [a-z0-9_] inside its string', () => {
    const text = graphPathSql({
      fromId: FROM,
      ownerId: OWNER,
      relations: ["x'); delete from t; --", 'nextval(1)'],
    });
    expect(text).toContain("e.relation in ('xdeletefromt','nextval1')");
    expect(readSql(text)).toBe(text);
  });
});
