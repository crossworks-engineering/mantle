/**
 * Brain-wide answers a write asks in the caller's scope after its item check
 * (migration 0300): yes or no, or a number, never a row. The scope reads
 * only the rows it reads, so asked there a name a hidden row holds would
 * read as free (then its unique index answers a 500, or two rows answer to
 * one name) and a budget would sum only the history the scope reads.
 *
 * Each runs on the executor given (a transaction's, so it sees the
 * transaction's own writes), else on `db`; on the system pool (no scope) the
 * definers answer as the system pool read.
 */
import { sql } from 'drizzle-orm';
import { db } from './gateway/handles';

type Exec = Pick<typeof db, 'execute'>;

/** What mantle_name_taken asks about (0300): a folder's path, a Recall map's
 *  slug (current or former), a formula's spec id. */
export type TakenName = 'folder' | 'recall-slug' | 'formula-spec';

/** Whether `name` is taken brain-wide (mantle_name_taken, 0300), rows the
 *  caller cannot read included; `exceptId` leaves one row out (a Recall
 *  map's own slugs). */
export async function nameTaken(
  what: TakenName,
  ownerId: string,
  name: string,
  opts: { exceptId?: string | null; q?: Exec } = {},
): Promise<boolean> {
  const rows = (await (opts.q ?? db).execute(
    sql`select "public"."mantle_name_taken"(${what}, ${ownerId}::uuid, ${name},
                                             ${opts.exceptId ?? null}::uuid) as taken`,
  )) as unknown as { taken: boolean | null }[];
  return rows[0]?.taken === true;
}

/** The bytes the brain's history copies take (mantle_snapshot_bytes, 0300):
 *  every copy, or the manual ones; with `member`, the members' (true) or
 *  everyone else's (false); with `loginId`, that login's. */
export async function snapshotBytesUsed(
  ownerId: string,
  opts: { manualOnly: boolean; member?: boolean | null; loginId?: string | null; q?: Exec },
): Promise<number> {
  const rows = (await (opts.q ?? db).execute(
    sql`select "public"."mantle_snapshot_bytes"(${ownerId}::uuid, ${opts.manualOnly},
                                                 ${opts.member ?? null}::boolean,
                                                 ${opts.loginId ?? null}::uuid)::text as n`,
  )) as unknown as { n: string | null }[];
  return Number(rows[0]?.n ?? 0);
}
