/**
 * `isBrainOwnerId`: the one question the extractor gate and the Recall compile
 * ask before they learn from an item (member logins Phase 0). Anything that is
 * not the brain, a member's personal space from Phase 2, answers false.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { isBrainOwnerId } from './resolve-owner';

const BRAIN = '11111111-1111-4111-8111-111111111111';
const PERSONAL_SPACE = '22222222-2222-4222-8222-222222222222';
const saved = process.env.ALLOWED_USER_ID;
process.env.ALLOWED_USER_ID = BRAIN;

afterAll(() => {
  if (saved === undefined) delete process.env.ALLOWED_USER_ID;
  else process.env.ALLOWED_USER_ID = saved;
});

describe('isBrainOwnerId', () => {
  it('is true for the brain', async () => {
    await expect(isBrainOwnerId(BRAIN)).resolves.toBe(true);
  });

  it('is false for anything else, such as a personal space', async () => {
    await expect(isBrainOwnerId(PERSONAL_SPACE)).resolves.toBe(false);
  });
});
