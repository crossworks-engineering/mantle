/**
 * Key status on the fleet (docs/control-center.md, "Key status on the
 * fleet"), read on a box: by its signed `facts` and `keyTest` cases
 * (server/web lib/control/box.ts), and on the Control Center for its own
 * box (the Fleet keys route, control_key_status): one line per provider
 * key, with when it was set, its last test and its print.
 *
 * What exists is read, nothing new is stored:
 *  - the key is the vault row (api_keys); its print is taken in memory from
 *    the opened key (providerKeyPrints, keyPrint). Only the print leaves;
 *  - its set time is the vault's own audit row of the last write of its
 *    value (`vault.key.set` naming `value`: an add, a new value), so an edit
 *    of its label, tags, target, approval or tailnet moves nothing. A key no
 *    vault write names (put there by onboarding or an internal writer) is
 *    set when its row was made;
 *  - its last test is the vault's own audit row of a test (`vault.key.test`:
 *    ok and when), written by every test: the Keys screen's, api_key_test,
 *    the fleet key set's, and keyTest here.
 *
 * A test runs only when a key is set and when a person asks (keyTest, the
 * Keys screen): no timer calls a provider. A failed test changes nothing:
 * testVaultKey only probes and writes its audit row.
 */
import type { SQL } from 'drizzle-orm';
import { and, auditLog, callerHasAreaBound, db, eq, inArray, sql } from '@mantle/db';
import { getProvider } from '@mantle/voice';
import type { ControlKeyLine } from '@mantle/client-types';
import { providerKeyPrints } from './index';
import { KNOWN_KEY_SERVICES } from './services';
import { canProbeService } from './probe';
import { testVaultKey, type VaultActor } from './vault';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/** Whether `service` is on this box's own fixed list: an AI provider, or a
 *  key service the box knows (the Keys screen's rows). The fleet key set
 *  takes only these, key status lists only these, and the Control Center
 *  keeps a box's line only for one of these. */
export function isFleetKeyService(service: string): boolean {
  return getProvider(service) !== null || KNOWN_KEY_SERVICES.some((k) => k.service === service);
}

/** The newest audit row of `action` per key id (`detail.keyId`), with
 *  `where` held too: its time, and whether its `ok` was true. */
async function lastRows(
  action: 'vault.key.set' | 'vault.key.test',
  keyIds: string[],
  where?: SQL,
): Promise<Map<string, { ok: boolean; at: string }>> {
  const out = new Map<string, { ok: boolean; at: string }>();
  if (keyIds.length === 0) return out;
  const keyId = sql<string>`${auditLog.detail}->>'keyId'`;
  const rows = await db
    .selectDistinctOn([keyId], {
      keyId,
      ok: sql<boolean>`coalesce((${auditLog.detail}->>'ok')::boolean, false)`,
      at: auditLog.createdAt,
    })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(keyId, keyIds), where))
    .orderBy(keyId, sql`${auditLog.createdAt} desc`);
  for (const r of rows) out.set(r.keyId, { ok: r.ok === true, at: new Date(r.at).toISOString() });
  return out;
}

/** This box's key lines, for the services on its own list. `ownerId` is the
 *  brain's anchor (the keys' owner). */
export async function keyLines(ownerId: string): Promise<ControlKeyLine[]> {
  const rows = await providerKeyPrints(ownerId, isFleetKeyService);
  const ids = rows.map((r) => r.id);
  const [sets, tests] = await Promise.all([
    lastRows('vault.key.set', ids, sql`${auditLog.detail}->'changed' @> '["value"]'::jsonb`),
    lastRows('vault.key.test', ids),
  ]);
  return rows.map((r) => ({
    service: r.service,
    setAt: sets.get(r.id)?.at ?? r.createdAt.toISOString(),
    print: r.print,
    testable: canProbeService(r.service),
    test: tests.get(r.id) ?? null,
  }));
}

/**
 * Test every key this box holds that its service can test, all at once,
 * through the vault's own test (its gate, its audit row), then read the
 * lines again. A test that cannot run (the vault's gate refused, the
 * database failed) throws: the caller hears a failure, never `ok` with the
 * old results. A provider that refuses or cannot be reached is no throw:
 * it is that key's failed test.
 */
export function testKeyLines(who: VaultActor, ownerId: string): Promise<ControlKeyLine[]> {
  // One test of an owner's keys at a time in this process: an ask while one
  // runs joins it (the Test now route, control_key_test, a box's keyTest), so
  // repeated asks never send a provider more than one probe per key at once.
  const running = testsRunning.get(ownerId);
  if (running) return running;
  const run = runTests(who, ownerId).finally(() => testsRunning.delete(ownerId));
  testsRunning.set(ownerId, run);
  return run;
}

const testsRunning = new Map<string, Promise<ControlKeyLine[]>>();

async function runTests(who: VaultActor, ownerId: string): Promise<ControlKeyLine[]> {
  const rows = await providerKeyPrints(ownerId, isFleetKeyService);
  await Promise.all(
    rows
      .filter((r) => canProbeService(r.service))
      .map((r) => testVaultKey(who, ownerId, { id: r.id })),
  );
  return keyLines(ownerId);
}

/** The Control Center's own box, for a person or an agent at it: its lines
 *  only for a caller who holds the vault's own area, `keys` (as the Keys
 *  screen), else `keys-area` and no key is opened. With `who`, its keys are
 *  tested first (a test already running joins). A read or a test that fails
 *  answers `error` for this box alone (logged), so the other boxes' answers
 *  still go. */
export async function ownKeyLines(
  ownerId: string,
  who?: VaultActor,
): Promise<{ ok: true; keys: ControlKeyLine[] } | { ok: false; reason: 'keys-area' | 'error' }> {
  if (!(await callerHasAreaBound('keys'))) return { ok: false, reason: 'keys-area' };
  try {
    return { ok: true, keys: who ? await testKeyLines(who, ownerId) : await keyLines(ownerId) };
  } catch (err) {
    log('control').warn("the Control Center's own key status failed:", errorMessage(err));
    return { ok: false, reason: 'error' };
  }
}
