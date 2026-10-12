import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { DISPATCHER_METHODS, dispatcherMethods, rule } from './no-model-in-transaction.mjs';

/**
 * No database transaction is held across a model call or a stream
 * (workspaces arch A2b, plan 4.2).
 */
describe('no-model-in-transaction', () => {
  it('reads the model calls from the dispatcher interfaces, promises only', () => {
    expect([...DISPATCHER_METHODS]).toEqual(
      expect.arrayContaining(['chat', 'chatStream', 'embed', 'extract', 'transcribe', 'decide']),
    );
    const text = [
      'export interface FooDispatcher extends AdapterMeta {',
      '  run(opts: X): Promise<Y>;',
      '  catalogue(): Z;',
      '  later?(',
      '    a: string,',
      '  ): Promise<void>;',
      '}',
      'export interface NotOne {',
      '  other(): Promise<void>;',
      '}',
    ].join('\n');
    expect([...dispatcherMethods(text)].sort()).toEqual(['later', 'run']);
  });

  const tester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });
  const file = '/r/packages/content/src/x.ts';

  it('flags a model call, a fetch or a stream inside a transaction, and only there', () => {
    tester.run('no-model-in-transaction', rule, {
      valid: [
        // Before and after the transaction.
        {
          code: 'const r = await adapter.chat(o); await db.transaction(async (tx) => { await tx.insert(t).values(r); });',
          filename: file,
        },
        {
          code: "import { embed } from '@mantle/embeddings'; const v = await embed(x); await withHeads([a], 'update', async (tx) => { await tx.update(t).set({ v }); });",
          filename: file,
        },
        // Not awaited: the transaction does not wait for it.
        {
          code: 'await withSystemTx(async (tx) => { void fetch(u); });',
          filename: file,
        },
        // A local function of the same name is not a model call.
        {
          code: 'const embed = async () => 1; await withSystemTx(async () => { await embed(); });',
          filename: file,
        },
        // Tests are out of scope.
        {
          code: 'await db.transaction(async () => { await adapter.chat(o); });',
          filename: '/r/packages/content/src/x.test.ts',
        },
      ],
      invalid: [
        {
          code: 'await db.transaction(async (tx) => { await adapter.chat(o); });',
          filename: file,
          errors: [{ messageId: 'held' }],
        },
        {
          code: "await withHeads([a], 'update', async (tx) => { const r = await route.adapter.chatStream(o, d); });",
          filename: file,
          errors: [{ messageId: 'held' }],
        },
        {
          code: "import { embed } from '@mantle/embeddings'; await withSystemTx(async (tx) => { await embed(x); });",
          filename: file,
          errors: [{ messageId: 'held' }],
        },
        {
          code: "import * as e from '@mantle/embeddings'; await sql.begin(async (t) => { await e.embedBatch(x); });",
          filename: file,
          errors: [{ messageId: 'held' }],
        },
        {
          code: 'await withScope(s, async () => { await fetch(u); });',
          filename: file,
          errors: [{ messageId: 'held' }],
        },
        {
          code: 'await readTransaction(async (tx) => { for await (const c of stream) use(c); });',
          filename: file,
          errors: [{ messageId: 'held' }],
        },
        // Nested inside a callback inside the transaction.
        {
          code: 'await withNodeInsertHeads(o, items, async (tx) => { await Promise.all(xs.map(async (x) => await vision.extract(x))); });',
          filename: file,
          errors: [{ messageId: 'held' }],
        },
      ],
    });
  });
});
