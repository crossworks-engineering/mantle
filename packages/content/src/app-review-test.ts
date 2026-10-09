/**
 * An admin tests a member's app before approving it (workspace review
 * pattern, 2026-10-09), in the normal app screen, on a THROWAWAY COPY of its
 * data. Nothing real changes: every statement of the test run reaches the
 * copy, never the member's database file, and the copy goes when the admin
 * leaves the screen (`endReviewTest`) or after REVIEW_TEST_IDLE_MS without a
 * statement (`sweepReviewTests`, run on every start and statement, and the
 * nightly leftovers sweep of `_tmp` as the last backstop).
 *
 * One copy per (admin login, app): <APP_DB_DIR>/_tmp/review/<login>/<app>.sqlite.
 * Both parts are uuids checked here, so no caller text reaches the path. The
 * copy is not an app database: no registry row, no table export, no MCP
 * tool and no other broker can find it. Its writes are rows only
 * (`dataOnly`), the team rule for a member's run. host.me() inside the test
 * answers the admin under the app's own viewer salt when it has one, else a
 * random salt kept beside the copy, so the test never provisions anything on
 * the real app.
 *
 * Not on the package index: import '@mantle/content/app-review-test' (it
 * reaches node:sqlite through the SQL runner, like app-broker).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { appDatabases, asSystem, db } from '@mantle/db';
import { isUuid } from '@mantle/std';
import {
  appDbFiles,
  appDbRoot,
  assertSafe,
  assertSafeScript,
  snapshotAppDatabase,
} from './app-broker';
import { APP_SCHEMA_TIMEOUT_MS, runAppSql } from './app-sql-runner';
import { bindViewerParams, resolveAppViewer, type AppViewer } from './app-viewer';
import type { MemberAppForReview } from './member-space-apps';

/** A test copy unused this long is removed. */
export const REVIEW_TEST_IDLE_MS = 30 * 60_000;

/** Copies one admin may hold at once; a new one past it drops the oldest. */
export const REVIEW_TEST_MAX_PER_ADMIN = 3;

/** The test copy is gone (left, timed out, or never started): start again. */
export class ReviewTestGoneError extends Error {
  constructor() {
    super('The test run ended. Start the test again.');
    this.name = 'ReviewTestGoneError';
  }
}

/** Who runs the test: the admin login, with its display name. */
export type ReviewTester = { loginId: string; name: string | null };

/** The app as the test needs it (from getMemberAppForReview). */
export type ReviewTestApp = Pick<
  MemberAppForReview,
  'id' | 'spaceId' | 'manifest' | 'dataReadOnly'
>;

function reviewRoot(): string {
  return path.join(appDbRoot(), '_tmp', 'review');
}

function testFile(loginId: string, appId: string): string {
  if (!isUuid(loginId) || !isUuid(appId)) throw new Error('review test: bad id');
  return path.join(reviewRoot(), loginId.toLowerCase(), `${appId.toLowerCase()}.sqlite`);
}

const saltFile = (file: string) => `${file}.salt`;

async function removeCopy(file: string): Promise<void> {
  await Promise.all([...appDbFiles(file), saltFile(file)].map((f) => rm(f, { force: true })));
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Remove every test copy idle past REVIEW_TEST_IDLE_MS. Returns how many. */
export async function sweepReviewTests(now = Date.now()): Promise<number> {
  let n = 0;
  let logins: string[];
  try {
    logins = await readdir(reviewRoot());
  } catch {
    return 0;
  }
  for (const login of logins) {
    let names: string[];
    try {
      names = await readdir(path.join(reviewRoot(), login));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.sqlite')) continue;
      const file = path.join(reviewRoot(), login, name);
      const m = await mtimeOf(file);
      if (m !== null && now - m > REVIEW_TEST_IDLE_MS) {
        await removeCopy(file);
        n++;
      }
    }
  }
  return n;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
function keepSweeping(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweepReviewTests().catch(() => {}), 5 * 60_000);
  sweepTimer.unref?.();
}

/** Drop this admin's oldest copies so a new one stays within the cap. */
async function capCopies(loginId: string, keep: string): Promise<void> {
  const dir = path.dirname(keep);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.sqlite'));
  } catch {
    return;
  }
  const others = (
    await Promise.all(
      names
        .map((f) => path.join(dir, f))
        .filter((f) => f !== keep)
        .map(async (f) => ({ f, m: (await mtimeOf(f)) ?? 0 })),
    )
  ).sort((a, b) => a.m - b.m);
  while (others.length >= REVIEW_TEST_MAX_PER_ADMIN) {
    await removeCopy(others.shift()!.f);
  }
}

/**
 * Start (or restart) the admin's test of a member's app: a fresh copy of
 * its data as it is now, with its declared schema applied to the copy when
 * the real file is behind it. The real file is only ever read (a VACUUM
 * INTO from a read-only open).
 */
export async function startReviewTest(
  tester: ReviewTester,
  app: ReviewTestApp,
): Promise<{ idleMs: number }> {
  keepSweeping();
  await sweepReviewTests();
  const file = testFile(tester.loginId, app.id);
  await mkdir(path.dirname(file), { recursive: true });
  await capCopies(tester.loginId, file);
  await removeCopy(file);
  try {
    const copied = await asSystem(() => snapshotAppDatabase(app.spaceId, app.id, file));
    const schema = app.manifest.sqlite;
    if (schema?.schemaSql.trim() && schema.schemaVersion > (copied?.schemaVersion ?? 0)) {
      assertSafeScript(schema.schemaSql);
      await runAppSql(file, {
        sql: schema.schemaSql,
        mode: 'script',
        readOnly: false,
        timeoutMs: APP_SCHEMA_TIMEOUT_MS,
        userVersion: schema.schemaVersion,
      });
    } else if (!copied) {
      // Nothing stored yet and no schema: an empty database to run on.
      await runAppSql(file, { sql: 'SELECT 1', mode: 'all', readOnly: false });
    }
    // The app's own salt when it has one (read, never created), so host.me()
    // gives the admin the id the app will see after an Approve.
    const [reg] = await asSystem(() =>
      db
        .select({ salt: appDatabases.viewerSalt })
        .from(appDatabases)
        .where(eq(appDatabases.appNodeId, app.id))
        .limit(1),
    );
    await writeFile(saltFile(file), reg?.salt ?? randomBytes(32).toString('base64url'), {
      mode: 0o600,
    });
  } catch (err) {
    await removeCopy(file);
    throw err;
  }
  return { idleMs: REVIEW_TEST_IDLE_MS };
}

/** End the admin's test: the copy goes. Idempotent. */
export async function endReviewTest(loginId: string, appId: string): Promise<void> {
  await removeCopy(testFile(loginId, appId));
}

/** The live copy for this admin and app, touched (still in use), or a
 *  ReviewTestGoneError. */
async function liveCopy(loginId: string, appId: string): Promise<string> {
  const file = testFile(loginId, appId);
  const m = await mtimeOf(file);
  if (m === null) throw new ReviewTestGoneError();
  if (Date.now() - m > REVIEW_TEST_IDLE_MS) {
    await removeCopy(file);
    throw new ReviewTestGoneError();
  }
  const now = new Date();
  await utimes(file, now, now).catch(() => {});
  return file;
}

async function viewerOf(
  file: string,
  app: ReviewTestApp,
  tester: ReviewTester,
): Promise<AppViewer> {
  return resolveAppViewer(
    app.spaceId,
    { kind: 'admin', loginId: tester.loginId, name: tester.name ?? undefined },
    async () => {
      const salt = (await readFile(saltFile(file), 'utf8')).trim();
      if (!salt) throw new ReviewTestGoneError();
      return salt;
    },
  );
}

/** What host.me() answers in the test frame, or null without a test. */
export async function reviewTestViewer(
  tester: ReviewTester,
  app: ReviewTestApp,
): Promise<AppViewer | null> {
  try {
    return await viewerOf(await liveCopy(tester.loginId, app.id), app, tester);
  } catch {
    return null;
  }
}

/** The app is informational: at team rules its runners only read. */
export class ReviewTestReadOnlyError extends Error {
  constructor() {
    super('This app is informational: at team rules its data is read only.');
    this.name = 'ReviewTestReadOnlyError';
  }
}

/**
 * One host.db statement of the test run, on the copy only. `query` opens it
 * read only; `exec` changes rows only (never the schema), at team rules, and
 * is refused on an informational app as a member's write would be.
 */
export async function reviewTestSql(
  tester: ReviewTester,
  app: ReviewTestApp,
  op: 'query' | 'exec',
  sql: string,
  params: unknown[],
): Promise<unknown> {
  if (op === 'exec' && app.dataReadOnly) throw new ReviewTestReadOnlyError();
  assertSafe(sql);
  const file = await liveCopy(tester.loginId, app.id);
  const bound = await bindViewerParams(sql, params, () => viewerOf(file, app, tester));
  const callerKey = `review:${tester.loginId}`;
  return op === 'query'
    ? runAppSql(file, { sql, params: bound, mode: 'all', readOnly: true, callerKey })
    : runAppSql(file, {
        sql,
        params: bound,
        mode: 'run',
        readOnly: false,
        dataOnly: true,
        callerKey,
      });
}
