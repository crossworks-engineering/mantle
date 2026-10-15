import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The advisory lock keys (A10 #15): every advisory lock the product takes,
 * with its lock function, its hash function and its key text, recorded on
 * main (v0.300.63) BEFORE the inline locks moved to advisoryXactLock and
 * tryAdvisoryXactLock (advisory-lock.ts). A lock key is the hash of the key
 * text, so two versions of the code exclude each other during a roll only
 * when both take the same function of the same hash of the same text: this
 * table may not change. The reader takes either form, the inline SQL of
 * main or the helper call, so the same test ran on main and runs now.
 */
const ROOT = join(__dirname, '../../..');

type Lock = { fn: string; hash: 'hashtext' | 'hashtextextended'; key: string };

const RECORDED: Record<string, Lock[]> = {
  'packages/content/src/app-history-lock.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtextextended', key: '`app-history:${appId}`' },
  ],
  'packages/content/src/member-snapshots.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtextextended', key: '`accepted-snapshot:${id}`' },
  ],
  'packages/content/src/member-turn-ledger.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtextextended', key: '`member-turn:${loginId}`' },
  ],
  'packages/content/src/node-snapshot-rows.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtextextended', key: '`node-seq:${row.nodeId}`' },
  ],
  'packages/content/src/recall-native.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtext', key: '`recall-map-create:${ownerId}`' },
  ],
  'packages/runtime/src/agent/chat-archive.ts': [
    {
      fn: 'pg_advisory_xact_lock',
      hash: 'hashtextextended',
      key: '`chat_threads:${ownerId}:${agentId}:${loginId}`',
    },
  ],
  'server/web/lib/access-keys.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtext', key: '`access-keys:${loginId}`' },
  ],
  'server/web/lib/maintenance/sweeps.ts': [
    {
      fn: 'pg_try_advisory_xact_lock',
      hash: 'hashtext',
      key: "'mantle:maintenance:entities-dedupe'",
    },
  ],
  'server/web/lib/oauth-lock.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtext', key: '`oauth-actor:${actorId}`' },
  ],
  'server/web/lib/snapshot-copies.ts': [
    { fn: 'pg_advisory_xact_lock', hash: 'hashtext', key: "'mantle_snapshot_copies'" },
  ],
};

/** The locks `text` takes, in either form. */
function locksIn(text: string): Lock[] {
  const out: Lock[] = [];
  // Main: sql`select pg_advisory_xact_lock(hashtextextended(${`k`}, 0))`, or a
  // literal key: hashtext('k').
  const inline =
    /select (pg_(?:try_)?advisory_xact_lock)\((hashtext(?:extended)?)\((?:\$\{(`[^`]*`)\}|('[^']*'))(?:, 0)?\)\)/g;
  for (const m of text.matchAll(inline)) {
    out.push({ fn: m[1]!, hash: m[2] as Lock['hash'], key: (m[3] ?? m[4])! });
  }
  // Now: advisoryXactLock(tx, `k`, 'hashtext') / tryAdvisoryXactLock(...).
  const helper =
    /\b(advisoryXactLock|tryAdvisoryXactLock)\(\s*[\w.]+,\s*(`[^`]*`|'[^']*'),\s*'(hashtext(?:extended)?)',?\s*\)/g;
  for (const m of text.matchAll(helper)) {
    out.push({
      fn: m[1] === 'advisoryXactLock' ? 'pg_advisory_xact_lock' : 'pg_try_advisory_xact_lock',
      hash: m[3] as Lock['hash'],
      key: m[2]!,
    });
  }
  return out;
}

describe('advisory lock keys (A10 #15)', () => {
  for (const [file, locks] of Object.entries(RECORDED)) {
    it(`${file} takes the locks recorded on main`, () => {
      expect(locksIn(readFileSync(join(ROOT, file), 'utf8'))).toEqual(locks);
    });
  }
});
