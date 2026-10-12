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
import { enterTestActor, takeActorMisses } from './packages/db/src/actor';

beforeAll(() => enterTestActor());
beforeEach(() => enterTestActor());

afterEach(() => {
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
