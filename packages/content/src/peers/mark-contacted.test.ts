/**
 * A peer's last-contact stamp is a note, never a failed peer call (A5 step
 * 3a low round): on a database that refuses the write (a read tool's
 * read-only actor, a reader role) markPeerContacted skips it, as
 * verifyInboundToken skips its last-seen stamp. Any other failure still
 * throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fail: null as null | Error }));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const update = () => ({
    set: () => ({
      where: async () => {
        if (h.fail) throw h.fail;
        return [];
      },
    }),
  });
  return { ...real, db: { update } };
});

import { forgetWriteRefusals } from '@mantle/db';
import { markPeerContacted } from './registry';

const OWNER = '99999999-9999-4999-8999-999999999999';
const PEER = '33333333-3333-4333-8333-333333333333';

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

describe('markPeerContacted (A5 step 3a low round)', () => {
  beforeEach(() => {
    h.fail = null;
    forgetWriteRefusals();
  });

  it('stamps the peer', async () => {
    await expect(markPeerContacted(OWNER, PEER)).resolves.toBeUndefined();
  });

  it('skips a refused write: the peer call is not failed by its note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const code of ['25006', '42501']) {
      forgetWriteRefusals();
      h.fail = pgError(code);
      await expect(markPeerContacted(OWNER, PEER), code).resolves.toBeUndefined();
    }
    warn.mockRestore();
  });

  it('still throws any other failure', async () => {
    h.fail = pgError('23505');
    await expect(markPeerContacted(OWNER, PEER)).rejects.toThrow('pg 23505');
  });
});
