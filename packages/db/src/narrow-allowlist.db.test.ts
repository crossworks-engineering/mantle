/**
 * The narrow login's write allowlist (plan v3.2 S7b part b2 round 8, the
 * class fix of the full audits). The narrow role's writes were derived by
 * table name, so a rights table with a plain name was narrow 'all': a raw
 * narrow session could make a run the runs sweep executes, swap a pending
 * call's tool or arguments, point a tool's handler (and with it a vault
 * key) at any host, rewrite a skill's instructions. Its writes are now a
 * measured allowlist (access-matrix.ts NARROW_WRITES): SELECT on every
 * table it may touch, and only the measured operations and columns on top.
 *
 * Sent raw on a narrow login session (no gateway, no text check), each in
 * a transaction that rolls back: the refused forms answer 42501 (the
 * privilege is checked before any row, so `where false` proves it), the
 * measured ones run. The forms still open until their move lands
 * (NARROW_MOVES_LEFT) are named in their own cell, so the next round turns
 * each to 42501.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the narrow login writes only its measured allowlist', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  let brain = '';
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const rr = await import('./runtime-role');
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
  }, 180_000);

  afterAll(async () => {
    for (const c of [nl, su]) await c?.end();
    await scratch?.drop();
  });

  /** One statement on `on` in a transaction that rolls back: 'ok' or the
   *  error's code. */
  const run = (on: ReturnType<typeof postgres>, stmt: string) =>
    on
      .begin(async (t) => {
        await t.unsafe(stmt);
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (e: { ok?: boolean; code?: string }) => (e.ok ? 'ok' : (e.code ?? 'error')),
      );

  it('a forged run and run item, and a run made to run, are refused (the sweep executes them)', async () => {
    for (const s of [
      `insert into runs (owner_id, title, status) values ('${brain}', 'forged', 'running')`,
      `insert into run_items (run_id, position, kind, state, payload)
         values (gen_random_uuid(), 0, 'tool_call', 'ready', '{"slug":"note_create"}')`,
      `update runs set status = 'running' where false`,
      `update runs set agent_id = null, login_id = null where false`,
      `update run_items set state = 'ready' where false`,
      `update run_items set payload = '{}' where false`,
      `delete from runs where false`,
    ]) {
      expect(await run(nl, s), s).toBe('42501');
    }
  });

  it('a pending call cannot be swapped: its tool, arguments, origin and maker are refused; its decision columns run', async () => {
    for (const s of [
      `update pending_tool_calls set args = '{}' where false`,
      `update pending_tool_calls set tool_slug = 'x' where false`,
      `update pending_tool_calls set origin = '{}' where false`,
      `update pending_tool_calls set elevated = true where false`,
      `update pending_tool_calls set login_id = null, agent_id = null where false`,
      `delete from pending_tool_calls where false`,
    ]) {
      expect(await run(nl, s), s).toBe('42501');
    }
    expect(
      await run(
        nl,
        `update pending_tool_calls set status = 'expired', result = '{}', error = null,
                decided_at = now(), executed_at = now(), updated_at = now() where false`,
      ),
    ).toBe('ok');
  });

  it("the vault and instruction forms: a tool's handler, a skill's instructions, an AI worker's or assistant's key are refused by the allowlist", async () => {
    for (const s of [
      `update tools set handler = '{"kind":"http","url":"https://example.invalid"}' where false`,
      `update tools set created_by = null where false`,
      `update tools set requires_confirm = false where false`,
      `update skills set instructions = 'x' where false`,
      `update skills set slug = 'x' where false`,
      `update heartbeats set schedule = '* * * * *' where false`,
      `update heartbeats set agent_slug = 'x', skill_slug = 'x' where false`,
      `update doc_collections set root_path = '/' where false`,
      `update channels set agent_id = null where false`,
      `update telegram_accounts set channel_id = null where false`,
    ]) {
      expect(await run(nl, s), s).toBe('42501');
    }
  });

  it('a table the narrow login never wrote is read only (a new table defaults to read)', async () => {
    for (const s of [
      `delete from push_instance where false`,
      `update brain_identity set updated_at = now() where false`,
      `delete from conversation_taints where false`,
      `delete from space_fold_items where false`,
      `update oauth_clients set redirect_uris = '{}' where false`,
      `update spaces set login_id = null where false`,
      `delete from item_marks where false`,
      `update ingest_rules set enabled = false where false`,
      `delete from heads_check_misses where false`,
    ]) {
      expect(await run(nl, s), s).toBe('42501');
    }
    expect(await run(nl, `select count(*) from push_instance`)).toBe('ok');
  });

  it('audit_log and actor_check_misses: insert only', async () => {
    for (const s of [
      `delete from audit_log where false`,
      `update audit_log set detail = null where false`,
      `delete from actor_check_misses where false`,
      `update actor_check_misses set detail = null where false`,
    ]) {
      expect(await run(nl, s), s).toBe('42501');
    }
    expect(
      await run(nl, `insert into audit_log (action, method, path) values ('t', 'POST', '/t')`),
    ).toBe('ok');
  });

  it('the measured writes run (traces, steps, the turn stream, a sandbox stamp)', async () => {
    for (const s of [
      `update traces set status = 'ok', finished_at = now() where false`,
      `update trace_steps set output = '{}' where false`,
      `update sandboxes set last_used_at = now() where false`,
      `update api_keys set last_used = now() where false`,
    ]) {
      expect(await run(nl, s), s).toBe('ok');
    }
  });

  it('still open until their moves land (NARROW_MOVES_LEFT, the next round): named so the move turns each to 42501', async () => {
    const open: [string, string][] = [
      [
        'pending-park',
        `insert into pending_tool_calls (owner_id, tool_slug, args) values ('${brain}', 'x', '{}')`,
      ],
      ['heartbeat-maker', `update heartbeats set created_by = null where false`],
      [
        'tool-config',
        `update tool_groups set configured_by = null, integration = null where false`,
      ],
      ['model-route', `update ai_workers set base_url = null, api_key_id = null where false`],
    ];
    for (const [, s] of open) expect(await run(nl, s), s).toBe('ok');
  });
});
