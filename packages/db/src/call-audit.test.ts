/**
 * The gate's tool call audit row waits for the transaction the call's
 * writes joined (A5 step 6d fix round 1): written once it commits, never
 * when it rolls back, and at once outside one. The transaction hooks are
 * stood in (afterOuterCommit's); the rows go to a sink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** The commit hooks of the open transaction; null: none is open. */
  open: null as null | Array<() => unknown>,
}));

vi.mock('./gateway/role-tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gateway/role-tx')>()),
  afterOuterCommit: async (fn: () => unknown) => {
    if (h.open) h.open.push(fn);
    else await fn();
  },
}));

import {
  inCallAuditFrame,
  registerCallAudit,
  resetCallAudit,
  startCallAudit,
  stopCallAudit,
  type CallAuditRow,
  type CallAuditSpec,
} from './call-audit';

const SPEC: CallAuditSpec = {
  kinds: ['tool'],
  succeeded: () => true,
  label: (c) => c.ref.name,
  describe: (c) => ({
    method: 'TOOL',
    path: null,
    detail: { tool: c.ref.name, ...c.notes },
    actorLabel: 'x',
  }),
};

const rows: CallAuditRow[] = [];

async function write(name: string, opts: { audited?: boolean } = {}): Promise<void> {
  await inCallAuditFrame(
    async () => ({ ok: true }),
    (value) => ({
      caller: { actor: null, via: 'turn' },
      ref: { kind: 'tool', name },
      policy: { effect: 'write' },
      input: {},
      value,
    }),
    opts,
  );
}

beforeEach(() => {
  resetCallAudit();
  registerCallAudit(SPEC);
  rows.length = 0;
  startCallAudit({ sink: (r) => rows.push(r) });
  h.open = null;
});
afterEach(() => {
  stopCallAudit();
  resetCallAudit();
});

describe('the audit row waits for the commit (A5 step 6d fix round 1)', () => {
  it('outside a transaction: written at once', async () => {
    await write('a');
    expect(rows.map((r) => r.detail.tool)).toEqual(['a']);
  });

  it('inside one: written when it commits, never when it rolls back', async () => {
    h.open = [];
    await write('committed');
    expect(rows).toEqual([]);
    for (const fn of h.open) await fn();
    expect(rows.map((r) => r.detail.tool)).toEqual(['committed']);

    rows.length = 0;
    h.open = [];
    await write('rolled-back');
    // A rollback drops the commit hooks: no row.
    h.open = null;
    expect(rows).toEqual([]);
  });

  it('a call its surface audits itself (`audited`) leaves none', async () => {
    await write('by-route', { audited: true });
    expect(rows).toEqual([]);
  });
});
