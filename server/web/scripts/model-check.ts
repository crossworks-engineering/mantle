/**
 * The model check on this box: does it run the shipped default model on
 * each worker and manifest agent? (lib/system-manifest/model-check.ts.)
 * Read-only: it reads config columns and changes nothing.
 *
 *   pnpm -C server/web models:check          # human-readable
 *   pnpm -C server/web models:check --json   # the report as JSON
 *
 * On a box (what scripts/fleet-model-check.mjs runs over ssh):
 *   docker exec mantle_web bun server/web/scripts/model-check.ts --json
 *
 * The brain: ALLOWED_USER_ID when set, else the box's one owner. Exit code
 * 0 when the report was made (drift or not: it reports, it does not gate),
 * 1 when it could not be made.
 */
import { db, agents } from '@mantle/db';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { computeModelCheck } from '../lib/system-manifest/model-check-db';

async function ownerId(): Promise<string> {
  const set = env('ALLOWED_USER_ID');
  if (set) return set;
  const rows = await db.selectDistinct({ ownerId: agents.ownerId }).from(agents);
  if (rows.length !== 1) {
    throw new Error(
      `${rows.length} owners have agents here: set ALLOWED_USER_ID to the brain's anchor`,
    );
  }
  return rows[0]!.ownerId;
}

function route(r: { provider: string; model: string; paramModels?: Record<string, string> }) {
  const extra = Object.entries(r.paramModels ?? {})
    .map(([k, v]) => ` ${k}=${v}`)
    .join('');
  return `${r.provider} / ${r.model}${extra}`;
}

async function main(): Promise<number> {
  if (!env('DATABASE_URL')) {
    console.error('model-check: DATABASE_URL must be set');
    return 1;
  }
  const report = await computeModelCheck(await ownerId());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report));
    return 0;
  }
  console.log(`Release ${report.appVersion}: ${report.notOk} row(s) not on the default.\n`);
  for (const r of report.rows) {
    if (r.status === 'ok') continue;
    const what =
      r.kind === 'worker'
        ? `worker ${r.name}${r.required ? ' (required)' : ''}`
        : `agent ${r.name}`;
    console.log(`  ${r.status.padEnd(7)} ${what}`);
    console.log(`          box:     ${r.box ? route(r.box) : '(none)'}`);
    console.log(`          default: ${route(r.default)}`);
  }
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`model-check: ${errorMessage(err)}`);
}
process.exit(code);
