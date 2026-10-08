/**
 * Before a box rolls to team apps Phase 2: what "the connector's level
 * decides" changes on it (packages/tools/src/connector-level-report.ts).
 * Read only. Numbers and ids only (app node ids, tool group ids), never a
 * title, slug or name: safe to paste from a client box.
 *
 *   pnpm -C server/web connector-levels           # one JSON document
 *
 * On a box: `docker exec mantle_web pnpm -C server/web connector-levels`.
 * An admin then raises a connector's level (Settings → Tool groups), with
 * Jason's OK, for each app that LOSES a tool; nothing here changes a level.
 */
import { closeDb, resolveSingleOwnerId } from '@mantle/db';
import { connectorLevelReport } from '@mantle/tools';

async function main(): Promise<void> {
  const ownerId = await resolveSingleOwnerId();
  if (!ownerId) {
    console.error('[connector-levels] no brain owner on this database');
    process.exitCode = 1;
    return;
  }
  const report = await connectorLevelReport(ownerId);
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error('[connector-levels] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
