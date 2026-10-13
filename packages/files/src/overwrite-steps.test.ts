/**
 * An overwrite's put-back (A3b part 2, fix rounds 1 and 2; ops/files.ts
 * overwriteSteps), with its lock transaction stood in for: decided under the
 * lock, it never falls back to the bytes-only branch, whatever the read-only
 * transaction's COMMIT does (N1); a lock it cannot take in time puts the
 * old bytes back only while the file holds this write's own bytes (N3).
 * The race with a second writer, on Postgres: a3b2-store-brokers.db.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { overwriteSteps } from './ops/files';

const dir = mkdtempSync(path.join(tmpdir(), 'overwrite-steps-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A file holding `old`, and a stage of `next` beside it. */
function setup(old: string, next: string) {
  const finalPath = path.join(dir, `${randomUUID()}.bin`);
  writeFileSync(finalPath, old);
  const tempPath = path.join(dir, `.${randomUUID()}.staged.tmp`);
  writeFileSync(tempPath, next);
  return { tempPath, finalPath, sha256: sha(next), size: next.length };
}

type LockTx = NonNullable<Parameters<typeof overwriteSteps>[2]>;

describe('overwriteSteps: the put-back', () => {
  it('decided "it landed" under the lock, then the COMMIT fails: the new bytes stay (N1)', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const staged = setup('old', 'new');
    const lockTx: LockTx = async (fn) => {
      await fn(async () => [{ sha: staged.sha256 }]);
      throw new Error('the read-only COMMIT fails');
    };
    const steps = overwriteSteps('id', staged, lockTx);
    await steps.place();
    await steps.unplace();
    expect(readFileSync(staged.finalPath, 'utf8')).toBe('new');
    quiet.mockRestore();
  });

  it('decided "never landed" under the lock: the old bytes go back once, whatever the COMMIT does', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const staged = setup('old', 'new');
    const lockTx: LockTx = async (fn) => {
      await fn(async () => [{ sha: sha('old') }]);
      throw new Error('the read-only COMMIT fails');
    };
    const steps = overwriteSteps('id', staged, lockTx);
    await steps.place();
    await steps.unplace();
    expect(readFileSync(staged.finalPath, 'utf8')).toBe('old');
    quiet.mockRestore();
  });

  it('the lock cannot be taken in time: put back only while the file holds this write own bytes (N3)', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timeout: LockTx = async () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    };
    const mine = setup('old', 'new');
    const a = overwriteSteps('id', mine, timeout);
    await a.place();
    await a.unplace();
    expect(readFileSync(mine.finalPath, 'utf8')).toBe('old');
    // Another write's bytes in the file by then: they stay.
    const theirs = setup('old', 'new');
    const b = overwriteSteps('id', theirs, timeout);
    await b.place();
    writeFileSync(theirs.finalPath, 'another write');
    await b.unplace();
    expect(readFileSync(theirs.finalPath, 'utf8')).toBe('another write');
    quiet.mockRestore();
  });
});
