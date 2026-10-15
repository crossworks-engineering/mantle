import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { liveWorkspaceSql } from './workspace-live';

describe('liveWorkspaceSql (A10 #15)', () => {
  it('writes the text the queries wrote by hand', () => {
    const q = sql`select 1 from workspaces w where w.owner_id = ${'o'} and ${liveWorkspaceSql('w')}`;
    expect(new PgDialect().sqlToQuery(q).sql).toBe(
      'select 1 from workspaces w where w.owner_id = $1 and w.archived_at is null',
    );
  });
  it('takes an alias only', () => {
    expect(() => liveWorkspaceSql('w; drop table x')).toThrow(/not an alias/);
  });
});
