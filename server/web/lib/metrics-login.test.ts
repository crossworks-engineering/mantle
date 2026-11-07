/**
 * The diagnostics' trace reads name the calling login (shownToLogin): the
 * error lists (topErrors, recentFailures) and the tool-validation telemetry
 * (toolValidationByTool, toolValidationRecent) read only the traces whose
 * login_id is unset or the caller's own, so one login never sees another's
 * errors, repairs or violation text. The database is stood in; each read's
 * WHERE is rendered as Postgres gets it. The rows themselves, between two
 * logins: server/web/server/screenshots-members.db.test.ts.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ wheres: [] as unknown[] }));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy']) {
    chain[k] = vi.fn(() => chain);
  }
  chain.where = vi.fn((c: unknown) => {
    h.wheres.push(c);
    return chain;
  });
  chain.limit = vi.fn(async () => []);
  // Awaited without .limit (toolValidationByTool).
  chain.then = (res: (v: unknown) => void) => Promise.resolve([]).then(res);
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});

import { recentFailures, toolValidationByTool, toolValidationRecent, topErrors } from './metrics';

const LOGIN = '00000000-0000-4000-8000-0000000000a1';
const rendered = () => new PgDialect().sqlToQuery(h.wheres.at(-1) as SQL);

beforeEach(() => {
  h.wheres.length = 0;
});

describe("the diagnostics' trace reads name the calling login", () => {
  for (const [name, read] of [
    ['topErrors', () => topErrors('o1', LOGIN, 7)],
    ['recentFailures', () => recentFailures('o1', LOGIN, 10)],
    ['toolValidationByTool', () => toolValidationByTool('o1', LOGIN, 7)],
    ['toolValidationRecent', () => toolValidationRecent('o1', LOGIN, 7)],
  ] as const) {
    it(`${name}: login_id unset or the caller's own`, async () => {
      await read();
      const q = rendered();
      expect(q.sql).toMatch(
        /\("traces"\."login_id" is null or "traces"\."login_id" = \$(\d+)::uuid\)/,
      );
      const n = Number(/"traces"\."login_id" = \$(\d+)::uuid/.exec(q.sql)![1]);
      expect(q.params[n - 1]).toBe(LOGIN);
      expect(q.params).toContain('o1');
    });
  }
});
