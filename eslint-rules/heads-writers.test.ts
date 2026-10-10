import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { isExempt, rule } from './heads-writers.mjs';

/**
 * Writers of the rows that carry access lock heads first (workspaces plan U1,
 * V2, V5). The database checks it at run time; this rule finds the writers
 * that would miss it (test 19 of the plan).
 */
describe('heads-writers', () => {
  it('skips tests and migrations', () => {
    expect(isExempt('/r/packages/db/src/workspaces.db.test.ts')).toBe(true);
    expect(isExempt('/r/packages/content/src/pages.test.ts')).toBe(true);
    expect(isExempt('/r/packages/db/migrations/0241_x.sql')).toBe(true);
    expect(isExempt('/r/packages/content/src/pages.ts')).toBe(false);
  });

  const tester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });
  const file = '/r/packages/content/src/x.ts';

  it('flags writes outside withHeads, and only those', () => {
    tester.run('heads-writers', rule, {
      valid: [
        // Inside withHeads / withSubtreeHeads.
        {
          code: 'withHeads([f], "share", async (tx) => { await tx.insert(nodes).values(v); });',
          filename: file,
        },
        {
          code: 'withSubtreeHeads(r, [a, b], async (tx) => { await tx.update(nodes).set({ path: p }); });',
          filename: file,
        },
        // The caller holds the heads.
        {
          code: '/** @heads-held by moveItem */\nasync function write(tx) { await tx.delete(nodes).where(w); }',
          filename: file,
        },
        {
          code: '/** @heads-held by ingest */\nexport const put = async (tx) => { await tx.insert(contentChunks).values(v); };',
          filename: file,
        },
        // A title save does not touch access.
        { code: 'db.update(nodes).set({ title: t, updatedAt: d }).where(w);', filename: file },
        { code: 'db.update(facts).set({ supersededBy: s }).where(w);', filename: file },
        {
          code: 'db.update(nodes).set({ data: d, ...(e ? { embedding: e } : {}), ...(t && { title: t }) });',
          filename: file,
        },
        // Reads, other tables, raw reads.
        { code: 'db.insert(pages).values(v);', filename: file },
        { code: 'sql`select * from nodes where id = ${id}`;', filename: file },
        { code: 'sql`update nodes set title = ${t}`;', filename: file },
        { code: 'sql`update nodes set title = ${t} where path = ${p}::ltree`;', filename: file },
        {
          code: 'withNodeInsertHeads(o, [{ type, path }], () => db.insert(nodes).values(v));',
          filename: file,
        },
        // A personal space's own rows (0244), in or out of a space scope.
        { code: 'withSpaceRows((tx) => tx.delete(nodes).where(w));', filename: file },
        {
          code: 'onSpaceRows(tx, s, async (q) => { await q.update(nodes).set({ path: p }); });',
          filename: file,
        },
        // Tests are exempt.
        { code: 'db.insert(nodes).values(v);', filename: '/r/packages/content/src/x.test.ts' },
      ],
      invalid: [
        { code: 'db.insert(nodes).values(v);', filename: file, errors: [{ messageId: 'noHeads' }] },
        {
          code: 'db.transaction(async (tx) => { await tx.delete(contentChunks).where(w); });',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.update(nodes).set({ path: p }).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.update(nodes).set({ title: t, ...(m ? { path: p } : {}) }).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.update(nodes).set({ title: t, ...rest }).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.update(nodes).set(patch).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.update(facts).set({ sourceNodeId: n }).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.insert(itemGrants).values(v);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`insert into content_chunks (node_id) values (${n})`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`update nodes set path = ${p} where id = ${id}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`update ${nodes} set path = ${p} where id = ${id}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`delete from "public"."nodes" where id = ${id}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        // A re-own and a login change are access changes too (0244, LOW a).
        {
          code: 'db.update(nodes).set({ ownerId: b, updatedAt: d }).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'db.update(nodes).set({ loginId: l }).where(w);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`update nodes n set owner_id = ${b} where n.id = ${id}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        // There is no exemption marker any more.
        {
          code: '// @heads-exempt: old code\nasync function w(tx) { await tx.insert(nodes).values(v); }',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
      ],
    });
  });
});
