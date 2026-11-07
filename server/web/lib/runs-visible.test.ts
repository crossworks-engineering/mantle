/**
 * Who sees a run (lib/runs-visible.ts): its own login; a run naming no
 * login, the brain owner's login only. The list's `where` says the same.
 * No database: the rule and the SQL it renders.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { runVisibleTo, runsVisibleWhere } from './runs-visible';

const BRAIN = '11111111-1111-4111-8111-111111111111';
const ADMIN_B = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const owner = { id: BRAIN, actor: { id: BRAIN } };
const adminB = { id: BRAIN, actor: { id: ADMIN_B } };

describe('who sees a run', () => {
  it("a run is its own login's; Admin B sees no other login's run", () => {
    expect(runVisibleTo({ loginId: ADMIN_B }, adminB)).toBe(true);
    expect(runVisibleTo({ loginId: ADMIN_B.toUpperCase() }, adminB)).toBe(true);
    expect(runVisibleTo({ loginId: BRAIN }, adminB)).toBe(false);
    expect(runVisibleTo({ loginId: MEMBER }, adminB)).toBe(false);
    expect(runVisibleTo({ loginId: MEMBER }, owner)).toBe(false);
  });

  it("a run naming no login is the brain owner's login's only", () => {
    expect(runVisibleTo({ loginId: null }, owner)).toBe(true);
    expect(runVisibleTo({ loginId: null }, adminB)).toBe(false);
  });

  it("the list's where: the brain, the login's own runs, and no-login runs for the owner only", () => {
    const render = (v: typeof owner) => new PgDialect().sqlToQuery(runsVisibleWhere(v));
    const b = render(adminB);
    expect(b.params).toEqual([BRAIN, ADMIN_B]);
    expect(b.sql).not.toMatch(/is null/i);
    const o = render(owner);
    expect(o.params).toEqual([BRAIN, BRAIN]);
    expect(o.sql).toMatch(/"login_id" is null/i);
  });
});
