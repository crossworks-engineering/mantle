/**
 * Import-only boot (scripts/boot-smoke.mjs; docs/deploy.md, "Boot smoke").
 *
 * v0.300.64 crash-looped every server process at start: a workspace package
 * without `"type": "module"` was loaded by tsx as CommonJS, so the names its
 * barrel re-exported with `export *` vanished and the importer died with
 * "does not provide an export named ...". Typecheck, vitest and the asset
 * build all passed: none of them boots an entry the way the image does.
 *
 * With MANTLE_BOOT_SMOKE=import-only, each process entry (server/web,
 * server/api, the workers, the migrate steps, the stdio MCP server) runs its
 * usual command up to the point where
 * its import graph is linked, loads the modules it would otherwise load
 * lazily, prints one line and exits 0, before it opens a pool, a listener or
 * a queue. A link failure (a missing export, a module that is not found)
 * exits non-zero, exactly as it would on a box.
 *
 * The switch takes one exact value, not a flag: only the smoke's stub env
 * sets it. A stray `MANTLE_BOOT_SMOKE=1` (or true, on, yes) left in a box's
 * .env is ignored, so it cannot turn every container into one that exits 0
 * at start and restarts forever.
 */
import { env } from './index';

/** The line the smoke runner waits for: a process that exits 0 without it
 *  did not reach its checkpoint. */
export const BOOT_SMOKE_MARK = '[boot-smoke] linked:';

/** The one value of MANTLE_BOOT_SMOKE that means an import-only boot. */
export const BOOT_SMOKE_VALUE = 'import-only';

/** Is this an import-only boot? Only on the exact {@link BOOT_SMOKE_VALUE};
 *  any other value, a flag word included, is ignored. */
export function isBootSmoke(): boolean {
  return env('MANTLE_BOOT_SMOKE') === BOOT_SMOKE_VALUE;
}

/**
 * The checkpoint: load what the entry would load later (`lazy`, in order,
 * so the first failure is the one reported), say so, exit 0. Never returns.
 * A rejection propagates to the entry, which exits non-zero.
 */
export async function bootSmokeExit(
  name: string,
  lazy: ReadonlyArray<() => Promise<unknown>> = [],
): Promise<never> {
  for (const load of lazy) await load();
  console.log(`${BOOT_SMOKE_MARK} ${name}${lazy.length ? ` (+${lazy.length} lazy loads)` : ''}`);
  process.exit(0);
}
