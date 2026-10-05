/**
 * Migration mobile_roles_push, the two steps that change existing rows, on a
 * real migrated Postgres. The statements are read from the migration file
 * and run again inside ONE transaction that is rolled back, so no other test
 * file's rows change:
 *
 *   - the dedupe before the unique routing-token index: rows that share a
 *     routing token are reduced to the newest, then the index is made;
 *   - the backfill of push_subscriptions.token_id: an old (unbound) row is
 *     bound to its login's phone token only when the login holds exactly ONE
 *     live phone token (the web client's token does not count).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/mobile-roles-push-migration.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Sql = ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>) & {
  unsafe: (q: string) => Promise<Row[]>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

/** The migration's statements (the file is found by name, not number). */
function statement(marker: string): string {
  const dir = join(__dirname, '..', 'migrations');
  const name = readdirSync(dir).find((f) => f.endsWith('_mobile_roles_push.sql'))!;
  const stmts = readFileSync(join(dir, name), 'utf8').split('--> statement-breakpoint');
  const found = stmts.filter((s) => s.includes(marker));
  expect(found, marker).toHaveLength(1);
  return found[0]!;
}

class Rollback extends Error {}

describe.skipIf(!URL)('migration mobile_roles_push: dedupe and token backfill', () => {
  let admin: Sql;
  const tag = `mrp-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const one = randomUUID(); // one live phone token and a web client token
  const two = randomUUID(); // two live phone tokens
  const webOnly = randomUUID(); // the web client's token only
  const dead = randomUUID(); // one revoked phone token
  const phoneOfOne = randomUUID();

  /** Run `fn` in a transaction and roll it back whatever happens. */
  async function rolledBack(fn: (tx: Sql) => Promise<void>): Promise<void> {
    try {
      await admin.begin(async (tx) => {
        await tx`set local lock_timeout = '20s'`;
        await fn(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    const m = await import('./index');
    admin = (m.systemDb as unknown as { $client: Sql }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin'),
      (${one}, ${`one-${tag}@example.invalid`}, 'x', 'admin'),
      (${two}, ${`two-${tag}@example.invalid`}, 'x', 'admin'),
      (${webOnly}, ${`web-${tag}@example.invalid`}, 'x', 'admin'),
      (${dead}, ${`dead-${tag}@example.invalid`}, 'x', 'admin')`;
    const later = "now() + interval '300 days'";
    await admin.unsafe(`insert into mobile_tokens (id, user_id, label, expires_at, revoked_at) values
      ('${phoneOfOne}', '${one}', 'Pixel', ${later}, null),
      ('${randomUUID()}', '${one}', 'Web client', ${later}, null),
      ('${randomUUID()}', '${two}', 'Phone A', ${later}, null),
      ('${randomUUID()}', '${two}', 'Phone B', ${later}, null),
      ('${randomUUID()}', '${webOnly}', 'Web client', ${later}, null),
      ('${randomUUID()}', '${dead}', 'Mobile device', ${later}, now())`);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const all = [anchor, one, two, webOnly, dead];
    await admin`delete from push_subscriptions where login_id = any(${all}::uuid[])`;
    await admin`delete from mobile_tokens where user_id = any(${all}::uuid[])`;
    await admin`delete from auth.users where id = any(${all}::uuid[])`;
  });

  it('keeps the newest row of each routing token, then makes the unique index', async () => {
    const dedupe = statement('DELETE FROM "push_subscriptions" a');
    const index = statement(
      'CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_routing_token_uq"',
    );
    await rolledBack(async (tx) => {
      await tx`drop index if exists push_subscriptions_routing_token_uq`;
      const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, s)).toISOString();
      const ids = {
        old: randomUUID(),
        mid: randomUUID(),
        newest: randomUUID(),
        alone: randomUUID(),
      };
      await tx`insert into push_subscriptions
                 (id, owner_id, login_id, routing_token, public_key, platform, created_at) values
        (${ids.old}, ${anchor}, ${one}, ${`${tag}-dup`}, 'pk', 'ios', ${at(1)}),
        (${ids.mid}, ${anchor}, ${two}, ${`${tag}-dup`}, 'pk', 'ios', ${at(2)}),
        (${ids.newest}, ${anchor}, ${one}, ${`${tag}-dup`}, 'pk', 'android', ${at(3)}),
        (${ids.alone}, ${anchor}, ${one}, ${`${tag}-alone`}, 'pk', 'ios', ${at(1)})`;
      await tx.unsafe(dedupe);
      await tx.unsafe(index);
      const rows = await tx`select id from push_subscriptions
                            where routing_token like ${`${tag}-%`} order by routing_token`;
      expect(rows.map((r) => r.id)).toEqual([ids.alone, ids.newest]);
      // The index holds: a second row of one routing token is refused.
      await expect(
        tx`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform)
           values (${anchor}, ${one}, ${`${tag}-alone`}, 'pk', 'ios')`,
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('binds an old row only where the login holds exactly one live phone token', async () => {
    const backfill = statement('UPDATE "push_subscriptions" ps');
    await rolledBack(async (tx) => {
      const legacy = async (login: string) =>
        (
          await tx`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform)
                   values (${anchor}, ${login}, ${`${tag}-${login}`}, 'pk', 'ios') returning id`
        )[0]!.id as string;
      const rows = {
        one: await legacy(one),
        two: await legacy(two),
        webOnly: await legacy(webOnly),
        dead: await legacy(dead),
      };
      await tx.unsafe(backfill);
      const tokenOf = async (id: string) =>
        (await tx`select token_id from push_subscriptions where id = ${id}`)[0]!.token_id;
      expect(await tokenOf(rows.one)).toBe(phoneOfOne);
      expect(await tokenOf(rows.two)).toBeNull(); // which phone: not certain
      expect(await tokenOf(rows.webOnly)).toBeNull(); // a browser enrols no phone
      expect(await tokenOf(rows.dead)).toBeNull(); // no live token
    });
  });
});
