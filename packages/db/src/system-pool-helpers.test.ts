/**
 * Who calls the system pool helpers of the approval queue and the
 * conversation store (pending-calls.ts, conversation-writes.ts). They write
 * on systemDb, and some take only a row id (revert, unclaim, settle): the
 * caller's rule (who may decide a call, whose thread a row is) is the
 * caller's own check before it calls them. So a new caller is reviewed:
 * each helper is called from the files named here and no others (tests and
 * the helpers' own modules left out).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Each helper and the files that may call it. */
const CALLERS: Record<string, readonly string[]> = {
  parkPendingCall: [
    'packages/runtime/src/agent/tool-loop/execute-call.ts',
    'packages/tools/src/pending-queue.ts',
    'packages/tools/src/toolsmith/groups.ts',
    'server/web/app/api/dev-tools/queue-approval/route.ts',
  ],
  decidePendingCall: ['packages/tools/src/pending.ts'],
  revertPendingCall: ['packages/tools/src/pending.ts'],
  unclaimPendingCall: ['packages/tools/src/pending.ts'],
  settlePendingCall: ['packages/tools/src/pending.ts'],
  insertConversationRow: ['packages/runtime/src/agent/conversation.ts'],
  settleConversationRow: ['packages/runtime/src/agent/conversation.ts'],
  supersedeConversationTurn: ['packages/runtime/src/agent/conversation.ts'],
};

const OWN = new Set([
  'packages/db/src/pending-calls.ts',
  'packages/db/src/conversation-writes.ts',
  'packages/db/src/index.ts',
]);

describe('the system pool helpers of pending calls and the conversation store', () => {
  it('are called from the reviewed files only', () => {
    const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f && !OWN.has(f) && !/\.test\.tsx?$/.test(f) && !f.includes('/test-support'));
    const found: Record<string, string[]> = Object.fromEntries(
      Object.keys(CALLERS).map((k) => [k, []]),
    );
    // A call: the name, then its argument list.
    const names = new RegExp(`\\b(${Object.keys(CALLERS).join('|')})\\s*\\(`, 'g');
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const m of new Set([...text.matchAll(names)].map((x) => x[1]!))) found[m]!.push(f);
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(CALLERS).map(([k, v]) => [k, [...v].sort()])),
    );
  });
});
