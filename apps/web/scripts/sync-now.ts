/**
 * One-shot: run a synchronous sync of every enabled IMAP account in this
 * process (bypasses pg-boss). Useful for manually re-triggering after
 * config changes — newly-discovered folders go through their 12-month
 * first scan.
 *
 *   cd apps/web && node --env-file=./.env.local --import tsx scripts/sync-now.ts
 */
import { eq } from 'drizzle-orm';
import { imap, syncAccount } from '@mantle/email';
import { db, emailAccounts } from '@mantle/db';

async function main() {
  const accounts = await db
    .select()
    .from(emailAccounts)
    .where(eq(emailAccounts.enabled, true));

  for (const a of accounts) {
    if (a.provider !== 'imap') {
      console.log(`skip ${a.address}: provider ${a.provider} not implemented`);
      continue;
    }
    console.log(`\n→ syncing ${a.address} …`);
    const t0 = Date.now();
    try {
      const { scanned, ingested } = await syncAccount(a, imap);
      console.log(
        `   done in ${((Date.now() - t0) / 1000).toFixed(1)}s — scanned=${scanned} ingested=${ingested}`,
      );
    } catch (err) {
      console.error('   FAILED:', (err as Error).message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
