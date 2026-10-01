/**
 * First-run signup names the anchor's role (client logins audit A14).
 * auth.users.role has no default since 0190, so an insert without it fails,
 * and this route answers any failed insert as "an account already exists":
 * a signup that forgot the role would lock a fresh install out with a
 * misleading message. The insert is read back from the stood-in database.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queries: [] as unknown[] }));

vi.mock('@mantle/db', () => ({
  countUsers: async () => 0,
  db: {
    execute: async (q: unknown) => {
      h.queries.push(q);
      return [{ id: 'x' }];
    },
  },
}));
vi.mock('@/lib/audit', () => ({ auditFireAndForget: () => {}, requestMetaFrom: () => ({}) }));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash' } }));

describe('POST /api/auth/signup', () => {
  it("inserts the anchor as an owner with role 'admin'", async () => {
    process.env.SESSION_SECRET ??= 'signup-role-test-secret-at-least-32-chars';
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://x/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ email: 'first@example.invalid', password: 'long-enough-pw' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.queries).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(h.queries[0] as SQL);
    const cols = /INSERT INTO auth\.users \(([^)]*)\)/
      .exec(sql)?.[1]
      ?.split(',')
      .map((c) => c.trim());
    expect(cols).toEqual(['id', 'email', 'password_hash', 'is_owner', 'role']);
    expect(sql).toMatch(/true, 'admin'/);
    expect(params).toContain('first@example.invalid');
  });
});
