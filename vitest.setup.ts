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
import { appendFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { enterTestActor, takeActorMisses, takeWriteRoleGaps } from './packages/db/src/actor';
import { takeFailOpenHits } from './packages/db/src/fail-open';

// Arch A2b2b: the suite runs the login write gateway as web and api do
// (openLoginWritePool in packages/db/src/client.ts reads this flag), so
// every scoped login write in a test goes to the write role (in warn).
(globalThis as { __mantleLoginWritePool?: boolean }).__mantleLoginWritePool = true;

beforeAll(() => enterTestActor());
beforeEach(() => enterTestActor());

// Plan v3.2 S4a: MANTLE_FAIL_OPEN_DUMP=<file> lists every fail-open hit of
// the run (site, actor kind, table, test file), one JSON line each: how the
// tables a scoped write sends to the system pool were measured
// (docs/actors.md, "Fail-open counts"). A hit never fails a test.
const failOpenDump = process.env.MANTLE_FAIL_OPEN_DUMP;
if (failOpenDump) {
  afterEach(() => {
    const hits = takeFailOpenHits();
    if (hits.length === 0) return;
    const file = expect.getState().testPath ?? '?';
    appendFileSync(failOpenDump, hits.map((h) => `${JSON.stringify({ ...h, file })}\n`).join(''));
  });
}

afterEach(() => {
  // Arch A2b2b: a right the write role does not hold, met by a login write
  // (the gateway notes every one, a caught one too). None may since plan
  // v3 S3 (no gap table is left): each is a table to add to the matrix, or
  // a bug.
  const gaps = takeWriteRoleGaps();
  if (gaps.length > 0) {
    throw new Error(
      `${gaps.length} login write(s) met a right the write role does not hold (arch A2b2b):\n` +
        gaps
          .slice(0, 10)
          .map((g) => `  ${g}`)
          .join('\n'),
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
