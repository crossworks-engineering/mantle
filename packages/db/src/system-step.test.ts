/**
 * The named system step's contract (F4 fix round 3, M2 and L5), the parts
 * that need no database: a step names its items or says why it has none,
 * and outside a workspace scope every item passes. The item check in a
 * scope and the refusal inside an open transaction run against a real
 * Postgres (server/web/server/f4-owner-flows.db.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { systemStep } from './system-step';

const A = '6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
const B = '7f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c';

describe('systemStep (F4 fix round 3)', () => {
  it('refuses a step that names no item and no why', async () => {
    await expect(systemStep('reindex', { items: [], need: 'read' }, async () => 1)).rejects.toThrow(
      /names no item/,
    );
    await expect(
      systemStep('export-sync', { items: 'none', why: '  ' }, async () => 1),
    ).rejects.toThrow(/names why/);
  });

  it('runs a step about no item, named with its why', async () => {
    await expect(
      systemStep('export-sync', { items: 'none', why: 'a test' }, async (allowed) => allowed),
    ).resolves.toEqual([]);
  });

  it('outside a workspace scope every item passes, in both forms', async () => {
    await expect(
      systemStep('derived-items', { items: [A, B], need: 'manage' }, async (allowed) => allowed),
    ).resolves.toEqual([A, B]);
    await expect(
      systemStep(
        'derived-items',
        { items: [A, B], need: 'manage', only: 'allowed' },
        async (allowed) => allowed,
      ),
    ).resolves.toEqual([A, B]);
    await expect(
      systemStep('derived-items', { items: [], need: 'manage', only: 'allowed' }, async (a) => a),
    ).resolves.toEqual([]);
  });
});
