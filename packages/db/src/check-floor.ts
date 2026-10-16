/**
 * The check modes' floor (migration 0298; docs/actors.md, "Pre-check
 * deletion"). With the tools' TypeScript item pre-checks gone, the
 * database's actor and edit checks are the only edit check of a tool's
 * write, so a brain runs both `on`. Below on is an emergency: lowering
 * needs an operator's reason (mantle_set_check refuses one without it) and
 * leaves a record (mantle_check_lowered()); migrate raises a box that is
 * below on with no record (raiseCheckFloor); and every process says so,
 * loudly, while a check is below on (checkFloorWarning, read by client.ts
 * when its pool opens and each minute after, never on a request's path).
 */
import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

/** Each check's box mode and the record of a lowering ('' when none). Any
 *  role the app runs as may read it (0298: mantle_check_lowered is on the
 *  runtime role's allowlist). */
export const CHECK_FLOOR_SQL = `
  SELECT "public"."mantle_check_box_mode"('actor_check') AS actor,
         "public"."mantle_check_box_mode"('edit_check') AS edit,
         "public"."mantle_check_lowered"() AS lowered`;

export type CheckFloorRow = { actor?: unknown; edit?: unknown; lowered?: unknown };

const SETTER: Record<'actor' | 'edit', string> = {
  actor: 'mantle_set_actor_check',
  edit: 'mantle_set_edit_check',
};

/**
 * The warning for a box whose checks are not both on, or '' (both on, or a
 * row that is not one). Names each check below on, the record of who
 * lowered it and why (or that none is recorded), and the one statement that
 * puts it back.
 */
export function checkFloorWarning(row: CheckFloorRow | undefined): string {
  if (!row) return '';
  const mode = (v: unknown) => (v === 'warn' || v === 'on' ? v : 'off');
  const modes = { actor: mode(row.actor), edit: mode(row.edit) };
  const low = (['actor', 'edit'] as const).filter((c) => modes[c] !== 'on');
  if (low.length === 0) return '';
  const lowered = typeof row.lowered === 'string' ? row.lowered.trim() : '';
  const which = low.map((c) => `the ${c} check is ${modes[c]}`).join(' and ');
  const why = lowered
    ? `Lowered by an operator: ${lowered}.`
    : 'No reason is recorded (a new or restored database before its migrate, or a bare ALTER DATABASE): the next migrate raises it to on.';
  const back = low.map((c) => `select ${SETTER[c]}('on');`).join(' ');
  return (
    `[db] SECURITY: ${which} on this brain. The tools' item pre-checks are gone, so ` +
    `below on a tool's write the database would refuse is made (docs/edit-check.md). ` +
    `${why} Put it back as the superuser that runs migrations: ${back} ` +
    `(docs/update-prod.md)`
  );
}

/** One process's last warning: said again only when it changes. */
let said = '';

/** Read the floor on `base` and warn when it changed (a pool's start, then
 *  each minute). A database before 0298 answers an error: ignored. */
export function noteCheckFloor(base: Sql, tag: string): void {
  base
    .unsafe(`${tag} ${CHECK_FLOOR_SQL}`)
    .then((rows) => {
      const line = checkFloorWarning(rows[0] as CheckFloorRow | undefined);
      if (line === said) return;
      said = line;
      // One loud line per change; none once both are on again.
      if (line) console.error(line);
    })
    .catch(() => {});
}

/** Tests only: forget the last warning. */
export function resetCheckFloorWarning(): void {
  said = '';
}

/**
 * Migrate's step (packages/db/src/migrate.ts): a box whose actor or edit
 * check is below on with no record of a lowering (a new database, a
 * restore, a bare ALTER DATABASE) is raised to on, the actor check first
 * (the edit check bites only where it is on). A box an operator lowered
 * with a reason is left as it is. Never fatal: a switch that cannot take
 * its locks (55P03) is a loud warning, and the processes keep saying so.
 * Needs the superuser that runs the migrations; a database before 0298 is
 * skipped.
 */
export async function raiseCheckFloor(
  sql: Sql,
  log: { info: (l: string) => void; warn: (l: string) => void },
): Promise<'on' | 'kept' | 'raised' | 'failed' | 'skipped'> {
  let row: CheckFloorRow | undefined;
  try {
    row = (
      await sql`SELECT "public"."mantle_check_box_mode"('actor_check') AS actor,
                       "public"."mantle_check_box_mode"('edit_check') AS edit,
                       "public"."mantle_check_lowered"() AS lowered`
    )[0] as CheckFloorRow | undefined;
  } catch {
    return 'skipped';
  }
  if (!row) return 'skipped';
  const low = (['actor', 'edit'] as const).filter((c) => row[c] !== 'on');
  if (low.length === 0) return 'on';
  const lowered = typeof row.lowered === 'string' ? row.lowered.trim() : '';
  if (lowered) {
    log.warn(`  WARNING ${checkFloorWarning(row)}`);
    return 'kept';
  }
  try {
    for (const c of low) {
      if (c === 'actor') await sql`select "public"."mantle_set_actor_check"('on')`;
      else await sql`select "public"."mantle_set_edit_check"('on')`;
      log.info(`  ${c} check: ${String(row[c])} -> on (no lowering recorded; docs/update-prod.md)`);
    }
    return 'raised';
  } catch (err) {
    log.warn(
      `  WARNING the checks could not be raised to on (${(err as { code?: string }).code ?? 'error'}): ` +
        `${checkFloorWarning(row)}`,
    );
    return 'failed';
  }
}
