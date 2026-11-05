/**
 * The read of a drawing's stored answers (data.drawingChecks on its file row):
 * every field circuit_verify writes comes back, the seal among them, so a sealed
 * answer applies; an answer the read did not carry its seal for would read as
 * written by hand and never apply. And the cap: newest per circuit, guess and
 * revision, the oldest revision dropped first, the current one never rotated.
 * No database, no model. On a real Postgres: checks-store.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  sealedRow,
  sealFieldsOf,
  STORED_CHECK_FIELDS,
  storedCheckOf,
  storedChecksOf,
  type StoredCheck,
} from './check';
import { sealOf } from './check-seal';
import { answersAfter, ANSWERS_CAP_BYTES } from './checks-store';
import { sourceStateOf } from './read';

process.env.MANTLE_MASTER_KEY ??= 'circuit-verify-test-key';

const C = '40000-001-01';
const FILE = '00000000-0000-4000-8000-0000000000f1';

const answer = (over: Partial<StoredCheck> = {}): StoredCheck => ({
  key: 'end:A@20.0,0.0',
  kind: 'end',
  circuit: C,
  node: '2',
  handles: 'A',
  guess: 'the pipe end #2 belongs to "V-201"',
  question: 'Does the pipe end connect to "V-201"?',
  answer: 'no',
  alt: 'break',
  reason: 'stops at a break symbol',
  trust: 'CHECKED BY IMAGE',
  model: 'test/vision-model',
  checkedAt: '2026-10-25T12:00:00.000Z',
  revision: 'rev1',
  file: FILE,
  crops: 'overview c0 c1',
  by: 'login:11111111-1111-4111-8111-111111111111',
  seal: '',
  ...over,
});

describe('the answers on the file row', () => {
  it('reads back every field, the seal among them, so a sealed answer applies', () => {
    const plain = answer();
    const stored = { ...plain, seal: sealOf(sealFieldsOf(FILE, plain)) };
    const [got] = storedChecksOf(JSON.parse(JSON.stringify([stored])));
    expect(got).toEqual(stored);
    for (const f of STORED_CHECK_FIELDS) expect(got![f], f).toBe(stored[f]);
    expect(sealedRow(FILE, got!)).toBe(true);
    // The id is sealed: an answer never applies to another file.
    expect(sealedRow('00000000-0000-4000-8000-0000000000f2', got!)).toBe(false);
    // The revision is sealed: never to other bytes.
    expect(sealedRow(FILE, { ...got!, revision: 'rev2' })).toBe(false);
    expect(sealedRow(FILE, { ...got!, reason: 'typed' })).toBe(false);
  });

  it('reads loosely: what is no list or no object is no answer', () => {
    expect(storedChecksOf(undefined)).toEqual([]);
    expect(storedChecksOf('x')).toEqual([]);
    expect(storedChecksOf([1, null, 'x'])).toEqual([]);
    expect(storedCheckOf({ answer: 'YES', node: 3 })).toMatchObject({
      answer: 'yes',
      node: '3',
      seal: '',
    });
  });

  it('a new answer replaces the same circuit, guess and revision; two circuits keep both', () => {
    const one = answer({ checkedAt: '2026-10-25T12:00:00.000Z' });
    const other = answer({ circuit: 'OTHER', checkedAt: '2026-10-25T12:00:00.000Z' });
    const again = answer({ answer: 'yes', circuit: ` ${C.toUpperCase()} `, checkedAt: 'z' });
    expect(answersAfter([one, other], [again], 'rev1')).toEqual([other, again]);
    expect(answersAfter([one], [answer({ revision: 'rev2' })], 'rev2')).toHaveLength(2);
  });

  it('past the cap the oldest revision goes first, and the current one never rotates', () => {
    const fill = (revision: string, at: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        answer({ key: `${revision}:${i}`, revision, checkedAt: at, reason: 'x'.repeat(4000) }),
      );
    const older = fill('rev0', '2026-01-01', 30);
    const newer = fill('rev1', '2026-02-01', 30);
    const added = fill('rev2', '2026-03-01', 20);
    const next = answersAfter([...older, ...newer], added, 'rev2')!;
    expect(new Set(next.map((c) => c.revision))).toEqual(new Set(['rev1', 'rev2']));
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(ANSWERS_CAP_BYTES);
    // The current revision alone past the cap keeps what it has: nothing rotates.
    const full = fill('rev3', '2026-04-01', 70);
    expect(answersAfter([], full, 'rev3')).toBeNull();
  });
});

describe('an old Table against its file', () => {
  it('no hash of the file is unreadable, never current', () => {
    expect(sourceStateOf('a', null)).toBe('unreadable');
    expect(sourceStateOf('a', 'a')).toBe('current');
    expect(sourceStateOf('a', 'b')).toBe('stale');
    expect(sourceStateOf(null, 'a')).toBe('unstamped');
  });
});
