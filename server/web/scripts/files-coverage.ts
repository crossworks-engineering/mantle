/**
 * pnpm -C server/web files:coverage [--json]
 *
 * How fully each file type is read on this box (the file ingestion
 * program's coverage check, lib/integrity/file-coverage.ts). Read only:
 * one SELECT in a READ ONLY transaction, a listing of the file database
 * folder and the one-word first line of the `.none` names of its files.
 * It prints file types and counts, never a file name or any text, so its
 * output may leave a client box.
 *
 * Columns: files; the read states (indexed, partial, failed, skipped,
 * pending, name only); db: files with a file database of those read, where
 * the type's Reader makes one ("-" where none is expected); short: files
 * with a shortcut cut; not full: the files the check counts as not read in
 * full. --json prints the rows with their skip reasons and cuts by reason.
 */
import { env } from '@mantle/config';
import { closeDb, resolveSingleOwnerId } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { coverageCheck, fileCoverage, type CoverageRow } from '../lib/integrity/file-coverage';

const json = process.argv.slice(2).includes('--json');

function table(rows: readonly CoverageRow[]): string {
  const head = [
    'type',
    'route',
    'files',
    'indexed',
    'partial',
    'failed',
    'skipped',
    'pending',
    'name only',
    'db',
    'short',
    'not full',
  ];
  const body = rows.map((r) => [
    `${r.ext}${r.popular ? '' : ' (not scored)'}`,
    r.route,
    r.files,
    r.indexed,
    r.partial,
    r.failed,
    r.skipped,
    r.pending,
    r.nameOnly,
    r.withDb === null ? '-' : `${r.withDb}/${r.withDb + r.noDb}`,
    r.shortcut,
    r.notFull,
  ]);
  const cells = [head, ...body].map((line) => line.map(String));
  const widths = head.map((_, i) => Math.max(...cells.map((c) => c[i]!.length)));
  return cells.map((c) => c.map((v, i) => v.padEnd(widths[i]!)).join('  ')).join('\n');
}

async function main(): Promise<number> {
  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (!ownerId) throw new Error('no brain owner (set ALLOWED_USER_ID)');
  const rows = await fileCoverage(ownerId);
  const check = coverageCheck(rows);
  if (json) {
    console.log(JSON.stringify({ notFull: check.count, rows }, null, 2));
    return 0;
  }
  console.log(table(rows));
  const files = rows.reduce((n, r) => n + r.files, 0);
  console.log(
    `\n${rows.length} types, ${files} files. Popular types: ${check.count} files not read in full.`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(`[files-coverage] ${errorMessage(err)}`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
