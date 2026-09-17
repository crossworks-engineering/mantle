/**
 * Behavioural tests for secret_create: the sealed-credential capture. It
 * had no test.
 *
 * The description promises the value "seals behind a key only the owner's
 * browser session can unlock" and is "REDACTED in trace logs". That is a
 * property about WHERE the plaintext goes, and it is exactly the kind of
 * thing a refactor breaks without any test noticing: one more field in the
 * metadata row, one more key in the output, and the credential is sitting in
 * a searchable jsonb column.
 *
 * So the success arm asserts, positively, that the plaintext reaches `seal`
 * (bound to the new node id as AAD) and, negatively, that it appears in NO
 * metadata insert and NOT in the tool output. The guard arm asserts that a
 * missing title or value inserts nothing at all: not even the lazy root.
 *
 * The DB edge is three `db.insert().values()` chains, stubbed; `seal` is
 * stubbed so the test does not need a master key. Tag sanitising and the
 * kind fallback are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const insertedRows: Array<Record<string, unknown>> = [];
const valuesFn = vi.fn((_v: unknown) => ({
  onConflictDoNothing: vi.fn(async () => undefined),
  returning: vi.fn(async () => insertedRows),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    db: { ...actual.db, insert: vi.fn(() => ({ values: valuesFn })) },
  };
});
vi.mock('@mantle/crypto', () => ({ seal: vi.fn() }));
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, nodeUrl: (id: string) => `https://brain.test/n/${id}` };
});

import { db, nodes, secrets } from '@mantle/db';
import { seal } from '@mantle/crypto';
import { SECRET_TOOLS } from './builtins-secrets';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const PLAINTEXT = 'hunter2-correct-horse';

const tool = SECRET_TOOLS.find((t) => t.slug === 'secret_create')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.splice(0, insertedRows.length, { id: NODE_ID, title: 'Safe PIN' });
  valuesFn.mockImplementation(() => ({
    onConflictDoNothing: vi.fn(async () => undefined),
    returning: vi.fn(async () => insertedRows),
  }));
  vi.mocked(seal).mockReturnValue({
    ciphertext: Buffer.from('sealed-bytes'),
    keyVersion: 3,
  } as never);
});

describe('secret_create', () => {
  it('declares the value as a redacted input field', () => {
    expect(tool.redactInputFields).toContain('value');
  });

  it('refuses a missing title or value WITHOUT inserting anything (not even the root)', async () => {
    expect(errorOf(await tool.handler({ title: '  ', value: 'x', kind: 'password' }, ctx))).toMatch(
      /title/,
    );
    expect(errorOf(await tool.handler({ title: 'PIN', value: '', kind: 'password' }, ctx))).toMatch(
      /value/,
    );
    expect(db.insert).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('seals the value against the new node id and keeps it out of every plaintext column', async () => {
    const res = await tool.handler(
      {
        title: ' Safe PIN ',
        value: PLAINTEXT,
        kind: 'password',
        label: 'PIN',
        description: 'the safe in the study',
        tags: [' Home ', 'home', '', 'x'.repeat(41), 'work'],
      },
      ctx,
    );

    // Three inserts, in order: lazy root, metadata row, sealed payload.
    const targets = vi.mocked(db.insert).mock.calls.map((c) => c[0]);
    expect(targets).toEqual([nodes, nodes, secrets]);

    const [root, meta, sealedRow] = valuesFn.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(root).toMatchObject({ ownerId: 'o1', type: 'branch', path: 'secrets' });
    expect(meta).toMatchObject({
      ownerId: 'o1',
      type: 'secret',
      title: 'Safe PIN',
      data: { kind: 'password', description: 'the safe in the study', field_count: 1 },
      // Sanitised: trimmed, lower-cased, deduped, over-long dropped.
      tags: ['home', 'work'],
    });
    // The plaintext is bound to THIS node as AAD, so the ciphertext cannot be
    // replayed into another row.
    expect(seal).toHaveBeenCalledWith(expect.stringContaining(PLAINTEXT), `secret:${NODE_ID}`);
    expect(JSON.parse(vi.mocked(seal).mock.calls[0]![0] as string)).toEqual({
      note: '',
      fields: [{ label: 'PIN', value: PLAINTEXT }],
    });
    expect(sealedRow).toMatchObject({ nodeId: NODE_ID, keyVersion: 3 });

    // THE property: the plaintext lands nowhere searchable and is not echoed.
    expect(JSON.stringify(root)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(meta)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(sealedRow)).not.toContain(PLAINTEXT);
    const out = outputOf(res);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
    expect(out).toMatchObject({ id: NODE_ID, title: 'Safe PIN', kind: 'password' });
    expect(String(out.message)).toMatch(/do not repeat/);
  });

  it("falls back to kind 'other' for an unknown category rather than refusing", async () => {
    const res = await tool.handler({ title: 'Wifi', value: 'pw', kind: 'wifi' }, ctx);
    const meta = valuesFn.mock.calls[1]![0] as { data: { kind: string } };
    expect(meta.data.kind).toBe('other');
    expect(outputOf(res)).toMatchObject({ kind: 'other' });
  });

  it('fails cleanly (and never seals) when the metadata insert returns no row', async () => {
    insertedRows.splice(0, insertedRows.length);
    expect(
      errorOf(await tool.handler({ title: 'PIN', value: 'x', kind: 'password' }, ctx)),
    ).toMatch(/failed to insert/);
    expect(seal).not.toHaveBeenCalled();
    // Only root + metadata were attempted; the secrets table was never touched.
    expect(vi.mocked(db.insert).mock.calls.map((c) => c[0])).toEqual([nodes, nodes]);
  });
});
