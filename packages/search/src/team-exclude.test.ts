/**
 * The `excludeTypes` filters behind the team surface (member logins Phase 0).
 * These render the real drizzle SQL so dropping a filter fails the test.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { visibleFactSource } from './entities';

const dialect = new PgDialect();

describe('visibleFactSource', () => {
  it('requires a source node that is not of a hidden type', () => {
    const q = dialect.sqlToQuery(visibleFactSource(['email', 'journal']));
    expect(q.sql).toContain('exists');
    expect(q.sql).toContain('source_node_id');
    expect(q.params).toContain('{"email","journal"}');
  });

  it('with nothing to hide, still drops facts with no source', () => {
    const q = dialect.sqlToQuery(visibleFactSource([]));
    expect(q.sql).toContain('is not null');
  });
});
