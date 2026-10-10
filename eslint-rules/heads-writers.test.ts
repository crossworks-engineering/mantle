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
        // Raw strings that read, or write under heads.
        { code: "tx.unsafe('select id from nodes where id = $1', [i]);", filename: file },
        { code: "db.execute(sql.raw('update nodes set title = 1'));", filename: file },
        {
          code: "withHeads([i], 'update', (tx) => tx.unsafe('delete from nodes where id = $1', [i]));",
          filename: file,
        },
        // A reviewed file may pass dynamic SQL; a literal concatenation is read.
        { code: 'tx.unsafe(stmt);', filename: '/r/packages/db/src/migrate.ts' },
        { code: "sql.unsafe('select 1 ' + (l ? 'limit 2' : ''));", filename: file },
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
        // Raw strings to .unsafe and sql.raw (W1 audit, LOW 3).
        {
          code: "tx.unsafe('delete from nodes c where c.type = $1', [t]);",
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'tx.unsafe(`insert into facts (content) values ($1)`, [c]);',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: "db.execute(sql.raw('update item_grants set write = true'));",
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        // A raw update of chunks, windows, facts or grants.
        {
          code: 'sql`update content_chunks set text = ${t} where id = ${id}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`update "public"."content_chunk_windows" w set text = ${t}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: 'sql`update ${facts} set source_node_id = ${n}`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        // MERGE and COPY into a guarded table.
        {
          code: 'sql`merge into nodes n using x on n.id = x.id when matched then delete`;',
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        {
          code: "tx.unsafe('copy content_chunks (text) from stdin');",
          filename: file,
          errors: [{ messageId: 'noHeads' }],
        },
        // Dynamic SQL to .unsafe outside the reviewed files, even under heads.
        { code: 'tx.unsafe(q, params);', filename: file, errors: [{ messageId: 'dynamicUnsafe' }] },
        {
          code: "withHeads([i], 'update', (tx) => tx.unsafe(stmt));",
          filename: file,
          errors: [{ messageId: 'dynamicUnsafe' }],
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
