/**
 * Runs in every test file (vitest.config.ts setupFiles).
 *
 * The actor check (workspaces arch A2a): the suite runs in warn
 * (MANTLE_ACTOR_CHECK, vitest.config.ts: the TypeScript check, and the SQL
 * check raised on every statement the app's pool sends), and a test fails
 * when any statement it caused ran with no actor bound: a process entry that forgot
 * its actor, or work that does not descend from any entry. A test is the
 * process entry of what it runs, as system(test) (enterTestActor): what it
 * awaits, its timers and its detached promises carry that, as an entry's
 * do in production. A test of an entry runs it in runWithoutActor, so the
 * entry must bind its own. A test that expects a miss takes it with
 * takeActorMisses() before it ends.
 */
import { afterEach, beforeAll, beforeEach } from 'vitest';
import { enterTestActor, takeActorMisses, takeWriteRoleGaps } from './packages/db/src/actor';
import { WRITE_ROLE_GAP_TABLES } from './packages/db/src/access-matrix';

// Arch A2b2b: the suite runs the login write gateway as web and api do
// (openLoginWritePool in packages/db/src/client.ts reads this flag), so
// every scoped login write in a test goes to the write role (in warn).
(globalThis as { __mantleLoginWritePool?: boolean }).__mantleLoginWritePool = true;

beforeAll(() => enterTestActor());
beforeEach(() => enterTestActor());

afterEach(() => {
  // Arch A2b2b: a login write the write role has no right for runs again on
  // the system pool (a write-role gap). Only the known tables may: a new
  // one is a table to add to the matrix, or to WRITE_ROLE_GAP_TABLES.
  const gaps = takeWriteRoleGaps().filter((g) => {
    const t = /^permission denied for table (\w+)$/.exec(g)?.[1];
    return !t || !(t in WRITE_ROLE_GAP_TABLES);
  });
  if (gaps.length > 0) {
    throw new Error(
      `${gaps.length} login write(s) met a right the write role does not hold (arch A2b2b):\n` +
        gaps.slice(0, 10).map((g) => `  ${g}`).join('\n'),
    );
  }
  const misses = takeActorMisses();
  if (misses.length === 0) return;
  const lines = misses
    .slice(0, 10)
    .map((m) => `  ${m.source} ${m.check}${m.detail ? ` from ${m.detail}` : ''}`);
  throw new Error(
    `${misses.length} statement(s) ran with no actor (arch A2a):\n${lines.join('\n')}\n` +
      'Bind the actor at the process entry (runAsActor or runAsSystem from @mantle/db).',
  );
});
