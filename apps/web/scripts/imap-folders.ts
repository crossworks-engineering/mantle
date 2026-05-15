/**
 * One-off probe: print every folder on every IMAP account, mark which are
 * currently in scope (according to imap_excluded_folders).
 *
 *   cd apps/web && node --env-file=./.env.local --import tsx scripts/imap-folders.ts
 */
import { eq } from 'drizzle-orm';
import { open } from '@mantle/crypto';
import { db, emailAccounts } from '@mantle/db';
import { probeImapConnection } from '@mantle/email';

async function main() {
  const accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.provider, 'imap'));

  for (const a of accounts) {
    if (!a.imapHost || !a.imapPort || !a.imapConfigEnc) {
      console.log(`  ${a.address}: skipped (incomplete config)`);
      continue;
    }
    const { password } = JSON.parse(
      open(a.imapConfigEnc, `imap:${a.userId}:${a.address}`),
    ) as { password: string };

    console.log(`\n${a.address}  (${a.imapHost}:${a.imapPort})`);
    console.log(`  excluded: ${JSON.stringify(a.imapExcludedFolders)}`);

    const probe = await probeImapConnection({
      host: a.imapHost,
      port: a.imapPort,
      secure: a.imapSecure,
      user: a.address,
      pass: password,
    });
    const excluded = new Set(a.imapExcludedFolders);
    console.log(`  server: ${probe.serverGreeting ?? '(no banner)'}`);
    console.log(`  ${probe.folders.length} folders (▶ = will be scanned):\n`);
    for (const f of probe.folders) {
      console.log(`  ${excluded.has(f) ? '  ' : '▶ '}${f}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
