/**
 * Re-seal every encrypted-at-rest column under a new master key.
 *
 * Procedure:
 *   1. Generate a new 32-byte base64 key: `openssl rand -base64 32`.
 *   2. Add it to .env.local as MANTLE_MASTER_KEY_NEXT (keep
 *      MANTLE_MASTER_KEY = the old one).
 *   3. Run: `pnpm -C server/web rotate:master-key`.
 *      - Every sealed column is decrypted with the matching key (via
 *        the version byte) and re-sealed under the new one. Rows
 *        already on v2 are skipped.
 *      - The script is idempotent — a crash mid-run picks up where it
 *        left off when re-invoked.
 *   4. When the script reports "all rows on v2", swap env: move
 *      MANTLE_MASTER_KEY_NEXT → MANTLE_MASTER_KEY, drop the old.
 *      Restart all processes.
 *
 * Tables touched:
 *   - api_keys.key_enc
 *   - api_keys.fields_enc             (nullable: a token has none; vault v2)
 *   - api_keys.held_enc               (cleared, not re-sealed: a change
 *                                      waiting for approval, 0347)
 *   - email_accounts.imap_config_enc  (nullable — accounts without IMAP creds are skipped)
 *   - channels.credentials_enc        (telegram bot token; see docs/comms-channels.md)
 *   - secrets.ciphertext
 *
 * AAD bindings (must match where the rows were originally sealed):
 *   - api_keys.key_enc   → row id for a token, `<id>:<kind>` for any other kind
 *   - api_keys.fields_enc → `<id>:fields`
 *     (both from @mantle/api-keys valueAad / fieldsAad, the vault's own)
 *   - email_accounts     → account id
 *   - channels           → channel id
 *   - secrets            → `secret:<node_id>`
 */
import { db, apiKeys, channels, emailAccounts, secrets } from '@mantle/db';
import { fieldsAad, valueAad } from '@mantle/api-keys';
import { currentSealVersion, open, seal, sealedKeyVersion } from '@mantle/crypto';
import { eq, isNotNull } from 'drizzle-orm';
import { env } from '@mantle/config';

async function assertReady(): Promise<void> {
  if (!env('MANTLE_MASTER_KEY')) {
    throw new Error('MANTLE_MASTER_KEY (the OLD key) must be set during rotation');
  }
  if (!env('MANTLE_MASTER_KEY_NEXT')) {
    throw new Error(
      'MANTLE_MASTER_KEY_NEXT must be set to a fresh 32-byte base64 key before running rotation',
    );
  }
  if (currentSealVersion() !== 2) {
    throw new Error(
      'currentSealVersion() !== 2 — expected MANTLE_MASTER_KEY_NEXT to switch the writer to v2',
    );
  }
}

type Counts = { scanned: number; resealed: number; alreadyV2: number };

async function rotateTable<T extends Record<string, unknown>>(
  name: string,
  fetchAll: () => Promise<Array<T & { id: string }>>,
  getCt: (row: T) => Buffer,
  aadFor: (row: T & { id: string }) => string,
  updateCt: (id: string, ct: Buffer, keyVersion: number) => Promise<void>,
): Promise<Counts> {
  const rows = await fetchAll();
  let resealed = 0;
  let alreadyV2 = 0;
  for (const row of rows) {
    const ct = getCt(row);
    const version = sealedKeyVersion(ct);
    if (version === 2) {
      alreadyV2++;
      continue;
    }
    try {
      const plaintext = open(ct, aadFor(row));
      const fresh = seal(plaintext, aadFor(row));
      await updateCt(row.id, fresh.ciphertext, fresh.keyVersion);
      resealed++;
    } catch (err) {
      console.error(`[rotate] ${name} row ${row.id} failed:`, (err as Error).message);
      throw err; // Bail loudly. Don't silently leave half-rotated rows.
    }
  }
  console.log(
    `[rotate] ${name}: scanned ${rows.length}, resealed ${resealed}, already v2 ${alreadyV2}`,
  );
  return { scanned: rows.length, resealed, alreadyV2 };
}

async function main() {
  await assertReady();
  console.log('[rotate] starting master key rotation → v2');

  const all: Counts[] = [];

  all.push(
    await rotateTable(
      'api_keys',
      () => db.select().from(apiKeys),
      (r) => r.keyEnc as Buffer,
      (r) => valueAad(r.id, r.kind),
      async (id, ct, kv) => {
        await db
          .update(apiKeys)
          .set({ keyEnc: ct, keyVersion: kv, updatedAt: new Date() })
          .where(eq(apiKeys.id, id));
      },
    ),
  );

  // api_keys.fields_enc (vault v2) is nullable: a token has no fields and
  // is skipped, as an email account without IMAP creds is below.
  {
    const rows = await db.select().from(apiKeys);
    let scanned = 0;
    let resealed = 0;
    let alreadyV2 = 0;
    for (const row of rows) {
      scanned++;
      if (!row.fieldsEnc) continue;
      const ct = row.fieldsEnc as Buffer;
      if (sealedKeyVersion(ct) === 2) {
        alreadyV2++;
        continue;
      }
      const fresh = seal(open(ct, fieldsAad(row.id)), fieldsAad(row.id));
      await db
        .update(apiKeys)
        .set({ fieldsEnc: fresh.ciphertext, updatedAt: new Date() })
        .where(eq(apiKeys.id, row.id));
      resealed++;
    }
    console.log(
      `[rotate] api_keys fields: scanned ${scanned}, resealed ${resealed}, already v2 ${alreadyV2}`,
    );
    all.push({ scanned, resealed, alreadyV2 });
  }

  // api_keys.held_enc (0347): a change an MCP client asked for, waiting
  // for approval. Not re-sealed: its AAD names the hold its pending call
  // carries, which this script does not read, and the rotation's write of
  // the key above makes it stale anyway (its approval says so). Cleared, so
  // no value sealed under the old key is left behind.
  {
    const cleared = await db
      .update(apiKeys)
      .set({ heldEnc: null })
      .where(isNotNull(apiKeys.heldEnc))
      .returning({ id: apiKeys.id });
    console.log(`[rotate] api_keys held changes cleared: ${cleared.length}`);
  }

  // email_accounts.imap_config_enc is nullable — accounts that don't
  // have IMAP creds (e.g. lingering rows from a removed provider) get
  // skipped by the `if (!row.imapConfigEnc)` short-circuit.
  {
    const rows = await db.select().from(emailAccounts);
    let scanned = 0;
    let resealed = 0;
    let alreadyV2 = 0;
    for (const row of rows) {
      scanned++;
      if (!row.imapConfigEnc) continue;
      const ct = row.imapConfigEnc as Buffer;
      const version = sealedKeyVersion(ct);
      if (version === 2) {
        alreadyV2++;
        continue;
      }
      const plaintext = open(ct, row.id);
      const fresh = seal(plaintext, row.id);
      await db
        .update(emailAccounts)
        .set({ imapConfigEnc: fresh.ciphertext, updatedAt: new Date() })
        .where(eq(emailAccounts.id, row.id));
      resealed++;
    }
    console.log(
      `[rotate] email_accounts: scanned ${scanned}, resealed ${resealed}, already v2 ${alreadyV2}`,
    );
    all.push({ scanned, resealed, alreadyV2 });
  }

  all.push(
    // The telegram bot token lives on `channels.credentials_enc` now
    // (docs/comms-channels.md), AAD-bound to the channel id.
    await rotateTable(
      'channels',
      () => db.select().from(channels),
      (r) => r.credentialsEnc as Buffer,
      (r) => r.id,
      async (id, ct, _kv) => {
        await db
          .update(channels)
          .set({ credentialsEnc: ct, updatedAt: new Date() })
          .where(eq(channels.id, id));
      },
    ),
  );

  all.push(
    await rotateTable(
      'secrets',
      () => db.select().from(secrets),
      (r) => r.ciphertext as Buffer,
      (r) => `secret:${r.nodeId}`,
      async (id, ct, kv) => {
        await db
          .update(secrets)
          .set({ ciphertext: ct, keyVersion: kv, updatedAt: new Date() })
          .where(eq(secrets.id, id));
      },
    ),
  );

  const totals = all.reduce(
    (acc, c) => ({
      scanned: acc.scanned + c.scanned,
      resealed: acc.resealed + c.resealed,
      alreadyV2: acc.alreadyV2 + c.alreadyV2,
    }),
    { scanned: 0, resealed: 0, alreadyV2: 0 },
  );
  console.log(
    `[rotate] done. scanned=${totals.scanned} resealed=${totals.resealed} alreadyV2=${totals.alreadyV2}`,
  );
  if (totals.scanned === totals.alreadyV2 + totals.resealed && totals.scanned > 0) {
    console.log(
      '[rotate] all rows on v2. Swap env: move MANTLE_MASTER_KEY_NEXT → MANTLE_MASTER_KEY, drop the old, restart processes.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
