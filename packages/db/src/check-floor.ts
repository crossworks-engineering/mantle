/**
 * The check modes' floor (migration 0301; docs/actors.md, "Pre-check
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
 *  role the app runs as may read it (0301: mantle_check_lowered is on the
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
 *  each minute). A database before 0301 answers an error: ignored. */
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

/** A check's rank: off < warn < on. */
function rank(mode: unknown): number {
  return mode === 'on' ? 2 : mode === 'warn' ? 1 : 0;
}

/**
 * Whether the record (mantle_check_lowered(): one entry per lowered check)
 * covers `check` at `mode`: an entry for that check whose recorded mode is
 * at or below `mode`. An operator's "on to warn" covers warn, and off raised
 * back to warn; a later bare ALTER DATABASE to off it does not (the entry
 * says warn), so migrate raises that one.
 */
export function loweredCovers(lowered: unknown, check: 'actor' | 'edit', mode: unknown): boolean {
  if (typeof lowered !== 'string' || lowered.trim() === '') return false;
  const re = new RegExp(
    `^\\S+ mantle\\.${check}_check (?:(?:off|warn|on) to|kept at) (off|warn|on) by `,
  );
  // Each entry starts with its time and its check: the reason after it
  // never counts (it may name the other check).
  return lowered.split(' | ').some((entry) => {
    const m = re.exec(entry.trim());
    return !!m && rank(m[1]) <= rank(mode);
  });
}

/** What migrate does with a check below on that no entry covers. */
export type CheckFloorPolicy = Readonly<{ policy: 'raise' | 'keep'; reason: string }>;

/**
 * MANTLE_CHECK_FLOOR (the image sets raise): raise (the default, and any
 * value but keep, said loudly) raises; keep leaves the box as it is, logs
 * a loud line and records why (MANTLE_CHECK_FLOOR_REASON) in the record,
 * so the box keeps warning and the next migrate keeps it too
 * (docs/update-prod.md, "Keep one box below on, on purpose").
 */
export function checkFloorPolicy(
  value: string | undefined,
  reason: string | undefined,
  log?: { warn: (l: string) => void },
): CheckFloorPolicy {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'keep') {
    const why =
      (reason ?? '').trim().slice(0, 200) || 'no reason given (MANTLE_CHECK_FLOOR_REASON)';
    return { policy: 'keep', reason: why };
  }
  if (v !== '' && v !== 'raise') {
    log?.warn(`  WARNING MANTLE_CHECK_FLOOR=${value} is not raise or keep: raise`);
  }
  return { policy: 'raise', reason: '' };
}

/** CHECK_FLOOR_SQL as a tagged template (the heads rule reads it). */
async function readFloor(sql: Sql): Promise<CheckFloorRow | undefined> {
  return (
    await sql`SELECT "public"."mantle_check_box_mode"('actor_check') AS actor,
                     "public"."mantle_check_box_mode"('edit_check') AS edit,
                     "public"."mantle_check_lowered"() AS lowered`
  )[0] as CheckFloorRow | undefined;
}

/**
 * Migrate's step (packages/db/src/migrate.ts): a check below on that the
 * record does not cover (a new database, a restore, a bare ALTER DATABASE,
 * also one below a recorded lowering) is raised to on, the actor check
 * first (the edit check bites only where it is on). A check an operator
 * lowered with a reason is left as it is, with a warning. Under
 * MANTLE_CHECK_FLOOR=keep nothing is raised: a loud line, and the record
 * gains an entry per uncovered check naming the keep and its reason. Never
 * fatal: a switch that cannot take its locks (55P03) is a loud warning,
 * and the processes keep saying so. Needs the superuser that runs the
 * migrations; a database before 0301 is skipped.
 */
export async function raiseCheckFloor(
  sql: Sql,
  log: { info: (l: string) => void; warn: (l: string) => void },
  floor: CheckFloorPolicy = { policy: 'raise', reason: '' },
): Promise<'on' | 'kept' | 'held' | 'raised' | 'failed' | 'skipped'> {
  let row: CheckFloorRow | undefined;
  try {
    row = await readFloor(sql);
  } catch {
    return 'skipped';
  }
  if (!row) return 'skipped';
  const low = (['actor', 'edit'] as const).filter((c) => row[c] !== 'on');
  if (low.length === 0) return 'on';
  const open = low.filter((c) => !loweredCovers(row.lowered, c, row[c]));
  if (open.length === 0) {
    log.warn(`  WARNING ${checkFloorWarning(row)}`);
    return 'kept';
  }
  try {
    if (floor.policy === 'keep') {
      for (const c of open) {
        const mode = row[c] === 'warn' ? 'warn' : 'off';
        const [who] = await sql<{ u: string }[]>`select session_user::text as u`;
        const entry =
          `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} mantle.${c}_check kept at ${mode} ` +
          `by ${who?.u ?? 'migrate'}: MANTLE_CHECK_FLOOR=keep at migrate, ${floor.reason}`;
        await sql`select "public"."mantle_check_note"(${`${c}_check`}, ${entry})`;
      }
      const now = await readFloor(sql);
      log.warn(
        `  WARNING MANTLE_CHECK_FLOOR=keep: ${open.map((c) => `the ${c} check`).join(' and ')} ` +
          `left below on, recorded: ${checkFloorWarning(now ?? row)}`,
      );
      return 'held';
    }
    for (const c of open) {
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
