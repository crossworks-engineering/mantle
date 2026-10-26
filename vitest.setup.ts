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
import {
  enterTestActor,
  takeActorMisses,
  takeNarrowDenials,
  takeNarrowUses,
  takeNarrowWrites,
  takeWriteRoleGaps,
} from './packages/db/src/actor';
import { SCOPED_SYSTEM_WRITES_LEFT, takeFailOpenHits } from './packages/db/src/fail-open';

// Arch A2b2b: the suite runs the login write gateway as web and api do
// (openLoginWritePool in packages/db/src/client.ts reads this flag), so
// every scoped login write in a test goes to the write role (in warn).
(globalThis as { __mantleLoginWritePool?: boolean }).__mantleLoginWritePool = true;

beforeAll(() => enterTestActor());
beforeEach(() => enterTestActor());

// Plan v3.2 S4a: MANTLE_FAIL_OPEN_DUMP=<file> lists every fail-open hit of
// the run (site, actor kind, table, test file), one JSON line each: how the
// tables a scoped write sends to the system pool were measured
// (docs/fail-open.md, "Measuring the system-pool tables").
//
// And S4b's refusal, rehearsed: a scoped typed write to a table the write
// role does not hold fails its test unless the table names
// scopedSystemWrite (it is then no hit) or is one of the tables still left
// to decide (SCOPED_SYSTEM_WRITES_LEFT). A new such write cannot reach S4b
// unseen. A cell that causes one on purpose takes it (takeFailOpenHits).
const failOpenDump = process.env.MANTLE_FAIL_OPEN_DUMP;
afterEach(() => {
  const hits = takeFailOpenHits();
  if (hits.length === 0) return;
  const file = expect.getState().testPath ?? '?';
  if (failOpenDump) {
    appendFileSync(failOpenDump, hits.map((h) => `${JSON.stringify({ ...h, file })}\n`).join(''));
  }
  const unnamed = [
    ...new Set(
      hits
        .filter((h) => h.site === 'typed-write')
        .map((h) => h.table ?? '?')
        .filter((t) => !SCOPED_SYSTEM_WRITES_LEFT.includes(t)),
    ),
  ];
  if (unnamed.length > 0) {
    throw new Error(
      `a scoped typed write went to the system pool on a table the write role does not hold, with no scopedSystemWrite reason (plan v3.2 S4a; S4b refuses it): ${unnamed.join(', ')}.\n` +
        'Write it through the write role, systemDb (infrastructure) or areaSystem (an Admin area), or name the reason on its access matrix row (docs/fail-open.md).',
    );
  }
});

// Plan v3.2 S7a: MANTLE_NARROW_DUMP=<file> lists the narrow route's uses
// by actor (one JSON line per test file and actor, with the count) and its
// denials: how each reason routed 'narrow' was measured with the switch on
// (docs/runtime-role.md, "The narrow route").
const narrowDump = process.env.MANTLE_NARROW_DUMP;

afterEach(() => {
  // Plan v3.2 S7a: a right the narrow role does not hold, met on the narrow
  // route (a caught one too). None may: each is a reason to route full with
  // its why (viewer.ts AS_SYSTEM_ROUTE), or a table to grant narrowly.
  const denied = takeNarrowDenials();
  const uses = takeNarrowUses();
  // Part a3: the narrow write counts (report only, never a failure).
  const writes = takeNarrowWrites();
  if (narrowDump && (denied.length > 0 || Object.keys(uses).length > 0 || writes.length > 0)) {
    const file = expect.getState().testPath ?? '?';
    const lines = [
      ...Object.entries(uses).map(([actor, n]) => JSON.stringify({ use: actor, n, file })),
      ...denied.map((d) => JSON.stringify({ denied: d.actor, what: d.what, file })),
      ...writes.map((w) =>
        JSON.stringify({ write: w.check, actor: w.actor, what: w.detail, file }),
      ),
    ];
    appendFileSync(narrowDump, `${lines.join('\n')}\n`);
  }
  if (denied.length > 0) {
    throw new Error(
      `${denied.length} statement(s) on the narrow route met a right mantle_system_narrow does not hold (plan v3.2 S7a):\n` +
        denied
          .slice(0, 10)
          .map((d) => `  ${d.actor}: ${d.what}`)
          .join('\n'),
    );
  }
});

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
