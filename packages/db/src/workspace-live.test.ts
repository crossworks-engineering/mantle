import { isNull, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { workspaces } from './schema/workspaces';
import { liveWorkspace, liveWorkspaceSql, liveWorkspaceText } from './workspace-live';

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
  it('the drizzle form writes what isNull(workspaces.archivedAt) wrote', () => {
    const d = new PgDialect();
    const by = (cond: ReturnType<typeof liveWorkspace>) =>
      d.sqlToQuery(sql`select 1 from ${workspaces} where ${cond}`).sql;
    expect(by(liveWorkspace())).toBe(by(isNull(workspaces.archivedAt)));
    expect(by(liveWorkspace())).toBe(
      'select 1 from "workspaces" where "workspaces"."archived_at" is null',
    );
  });
  it('the text form is the same text, for a plain SQL string', () => {
    expect(liveWorkspaceText('w')).toBe('w.archived_at is null');
    expect(() => liveWorkspaceText('w"')).toThrow(/not an alias/);
  });
});
