/**
 * Migration 0182's used_private backfill (audit F23) on a fixture, on a real
 * migrated Postgres: the statement is read from the migration file and run
 * again (it is idempotent). It must mark what run-team-turn.ts marks live:
 *
 *   - a member-login reply whose trace has a my-space tool step;
 *   - every later reply of that login whose history window (the agent's
 *     history_limit rows before its inbound message) held a marked reply;
 *
 * and nothing else: not another login's replies, not a portal (contact)
 * thread, not a reply outside the window.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/used-private-backfill.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

/** The backfill statement: the migration's last statement. */
function backfillSql(): string {
  const file = readFileSync(
    join(__dirname, '..', 'migrations', '0182_member_turn_ledger.sql'),
    'utf8',
  );
  const stmt = file.split('--> statement-breakpoint').at(-1)!;
  expect(stmt).toContain('UPDATE team_messages');
  return stmt;
}

describe.skipIf(!URL)('0182 used_private backfill', () => {
  let m: typeof import('./index');
  let admin: ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>) & {
    unsafe: (q: string) => Promise<Row[]>;
  };
  const tag = `upb-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const pat = randomUUID(); // read a private note in turn 2
  const sam = randomUUID(); // never did
  const lee = randomUUID(); // did, on an agent whose history window is 0 rows
  const contact = randomUUID();
  const agentNoHistory = randomUUID();
  const traceId = { pat: randomUUID(), lee: randomUUID(), portal: randomUUID() };
  const ids: Record<string, string> = {};
  let t = 0;

  /** One turn: an inbound and its reply, a second apart, in thread order. */
  async function turn(
    key: string,
    who: { loginId?: string; contactId?: string },
    opts: { traceId?: string; agentId?: string } = {},
  ) {
    const inId = randomUUID();
    const outId = randomUUID();
    ids[key] = outId;
    const at = (n: number) => new Date(Date.UTC(2026, 8, 20, 10, 0, n)).toISOString();
    await admin`insert into team_messages (id, owner_id, contact_id, login_id, direction, text, created_at)
      values (${inId}, ${anchor}, ${who.contactId ?? null}, ${who.loginId ?? null}, 'inbound', 'ask', ${at(t++)})`;
    await admin`insert into team_messages
      (id, owner_id, contact_id, login_id, direction, text, trace_id, agent_id, created_at)
      values (${outId}, ${anchor}, ${who.contactId ?? null}, ${who.loginId ?? null}, 'outbound', 'reply',
              ${opts.traceId ?? null}, ${opts.agentId ?? null}, ${at(t++)})`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('./index');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin'),
      (${pat}, ${`pat-${tag}@example.invalid`}, 'x', 'member'),
      (${sam}, ${`sam-${tag}@example.invalid`}, 'x', 'member'),
      (${lee}, ${`lee-${tag}@example.invalid`}, 'x', 'member')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${contact}, ${anchor}, 'contact', 'Old portal member', 'contacts')`;
    await admin`insert into agents (id, owner_id, slug, name, model, system_prompt, memory_config)
      values (${agentNoHistory}, ${anchor}, ${`nohist-${tag}`}, 'No history', 'test/model', 'x',
              '{"history_limit":0}'::jsonb)`;
    for (const [key, tid] of Object.entries(traceId)) {
      await admin`insert into traces (id, owner_id, kind, subject_kind, status)
        values (${tid}, ${anchor}, 'responder_turn', 'team_turn', 'success')`;
      await admin`insert into trace_steps (trace_id, ordinal, name, kind, status)
        values (${tid}, 0, ${key === 'lee' ? 'tool: my_item_open' : 'tool: my_items_list'}, 'db_read', 'success')`;
    }
    await turn('pat1', { loginId: pat });
    await turn('pat2', { loginId: pat }, { traceId: traceId.pat });
    await turn('pat3', { loginId: pat });
    await turn('pat4', { loginId: pat });
    await turn('sam1', { loginId: sam });
    await turn('lee1', { loginId: lee }, { traceId: traceId.lee, agentId: agentNoHistory });
    await turn('lee2', { loginId: lee }, { agentId: agentNoHistory });
    await turn('portal1', { contactId: contact }, { traceId: traceId.portal });
    await turn('portal2', { contactId: contact });
    await admin.unsafe(backfillSql());
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_messages where owner_id = ${anchor}`;
    await admin`delete from traces where owner_id = ${anchor}`;
    await admin`delete from agents where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id = ${anchor}`;
    await admin`delete from auth.users where id in (${pat}, ${sam}, ${lee}, ${anchor})`;
    await m.closeDb();
  });

  const marked = async (key: string) =>
    (await admin`select used_private from team_messages where id = ${ids[key]!}`)[0]!.used_private;

  it('marks the reply that read private items, and the replies that followed it', async () => {
    expect(await marked('pat1')).toBe(false);
    expect(await marked('pat2')).toBe(true);
    expect(await marked('pat3')).toBe(true);
    expect(await marked('pat4')).toBe(true);
  });

  it("leaves another login's thread and the portal threads alone", async () => {
    expect(await marked('sam1')).toBe(false);
    expect(await marked('portal1')).toBe(false);
    expect(await marked('portal2')).toBe(false);
  });

  it('follows the agent history window: none loaded, nothing carried forward', async () => {
    expect(await marked('lee1')).toBe(true);
    expect(await marked('lee2')).toBe(false);
  });

  it('is idempotent', async () => {
    await admin.unsafe(backfillSql());
    expect(await marked('pat4')).toBe(true);
    expect(await marked('sam1')).toBe(false);
  });
});
