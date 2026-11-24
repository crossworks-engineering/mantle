/**
 * Key status on the fleet (docs/control-center.md, "Key status on the
 * fleet"), read on a box: by its signed `facts` and `keyTest` cases
 * (server/web lib/control/box.ts), and on the Control Center for its own
 * box (the Fleet keys route, control_key_status): one line per provider key this box holds, with
 * when the vault last wrote it, its last test and its print.
 *
 * What exists is read, nothing new is stored:
 *  - the key and its set time are the vault row (api_keys, its updated_at);
 *  - the last test is the vault's own audit row of a test
 *    (`vault.key.test`: the key id, ok, when), written by every test: the
 *    Keys screen's, api_key_test, the fleet key set's, and keyTest here;
 *  - the print is taken in memory from the opened key (providerKeyPrints,
 *    @mantle/api-keys keyPrint). Only the print leaves this module.
 *
 * A test runs only when a key is set and when a person asks (keyTest, the
 * Keys screen): no timer calls a provider. A failed test changes nothing:
 * testVaultKey only probes and writes its audit row.
 */
import { and, auditLog, db, eq, inArray, sql } from '@mantle/db';
import { getProvider } from '@mantle/voice';
import { providerKeyPrints } from './index';
import { KNOWN_KEY_SERVICES } from './services';
import { canProbeService } from './probe';
import { testVaultKey, type VaultActor } from './vault';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import type { ControlKeyLine } from '@mantle/client-types';

/** Whether `service` is on this box's own fixed list: an AI provider, or a
 *  key service the box knows (the Keys screen's rows). The fleet key set
 *  takes only these, and key status lists only these. */
export function isFleetKeyService(service: string): boolean {
  return getProvider(service) !== null || KNOWN_KEY_SERVICES.some((k) => k.service === service);
}

/** The last `vault.key.test` row of each key id: ok and when. */
async function lastTests(keyIds: string[]): Promise<Map<string, { ok: boolean; at: string }>> {
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
    .where(and(eq(auditLog.action, 'vault.key.test'), inArray(keyId, keyIds)))
    .orderBy(keyId, sql`${auditLog.createdAt} desc`);
  for (const r of rows) out.set(r.keyId, { ok: r.ok === true, at: new Date(r.at).toISOString() });
  return out;
}

/** This box's key lines, for the services on its own list. `ownerId` is the
 *  brain's anchor (the keys' owner). */
export async function keyLines(ownerId: string): Promise<ControlKeyLine[]> {
  const rows = await providerKeyPrints(ownerId, isFleetKeyService);
  const tests = await lastTests(rows.map((r) => r.id));
  return rows.map((r) => ({
    service: r.service,
    setAt: r.setAt.toISOString(),
    print: r.print,
    testable: canProbeService(r.service),
    test: tests.get(r.id) ?? null,
  }));
}

/**
 * Test every key this box holds that its service can test, all at once,
 * through the vault's own test (its gate, its audit row), then read the
 * lines again. A key whose test throws keeps its last result.
 */
export async function testKeyLines(who: VaultActor, ownerId: string): Promise<ControlKeyLine[]> {
  const rows = await providerKeyPrints(ownerId, isFleetKeyService);
  await Promise.all(
    rows
      .filter((r) => canProbeService(r.service))
      .map((r) =>
        testVaultKey(who, ownerId, { id: r.id }).catch((err: unknown) => {
          log('control').warn(`key test ${r.service} failed to run:`, errorMessage(err));
        }),
      ),
  );
  return keyLines(ownerId);
}
