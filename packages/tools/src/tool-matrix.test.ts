/**
 * The tools' matrix declarations (plan v3.2 S11a; tool-policy.ts ToolMatrix),
 * no database. A write declares one (the type asks: a write policy without
 * one does not build), and a read that takes an item id (id, *_id, node_id,
 * ids) declares one too (this test asks, from the schemas). An action names
 * an argument its schema takes and kinds the registry has. The declaration
 * states intent only: no code but the A8 cells and this test reads it, so it
 * is never a pre-check.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { GUIDE_ACTIONS } from '@mantle/db/matrix/guide-oracle';
import { ITEM_ID_PARAM, itemIdParams } from '@mantle/db/matrix/a8-tool-cells';
import { BUILTIN_TOOLS } from './builtins';
import { MCP_SURFACE_POLICIES } from './mcp-surface-policies';
import type { ToolPolicy } from './tool-policy';

const ROOT = join(__dirname, '../../..');

/** The ways code reads a policy's matrix field. A declaration
 *  (`matrix: { ... }` in a policy literal) is none of them: its value opens a
 *  brace, which the destructuring forms do not hold. */
const MATRIX_READ: readonly RegExp[] = [
  // policy.matrix, policy?.matrix, def.policy.matrix
  /[\w)\]]\??\.matrix\b(?!\.test)/,
  // policy['matrix'], policy?.["matrix"]
  /\[\s*['"`]matrix['"`]\s*\]/,
  // 'matrix' in policy
  /['"`]matrix['"`]\s+in\b/,
  // const { matrix } = p; const { effect, matrix: m } = p; ({ matrix }) =>;
  // function f({ matrix }: ToolPolicy)
  /\{[^{};]*\bmatrix\b[^{};]*\}\s*(?:=(?![=>])|\)|:\s*[A-Z])/,
];

/** The source without its comments (a comment that names the access matrix
 *  is no read). */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('the matrix declarations', () => {
  it('a write policy without one does not build (the type)', () => {
    // @ts-expect-error: a write declares its matrix.
    const missing: ToolPolicy = { effect: 'write', spends: 'none', scope: 'any' };
    const read: ToolPolicy = { effect: 'read', spends: 'none', scope: 'any' };
    expect([missing.effect, read.effect]).toEqual(['write', 'read']);
  });

  it('every builtin write declares one, and every read taking an item id', () => {
    const missing: string[] = [];
    for (const b of BUILTIN_TOOLS) {
      const ids = itemIdParams(b.inputSchema);
      if (b.policy.effect === 'write' || ids.length) {
        if (!b.policy.matrix) missing.push(`${b.slug} (${b.policy.effect}: ${ids.join(', ')})`);
      }
    }
    for (const [slug, p] of Object.entries(MCP_SURFACE_POLICIES) as [string, ToolPolicy][]) {
      if (p.effect === 'write' && !p.matrix) missing.push(`${slug} (the MCP surface's)`);
    }
    expect(missing).toEqual([]);
  });

  it('an action names an argument the schema takes, an action of the guide, kinds of the registry', () => {
    const bad: string[] = [];
    for (const b of BUILTIN_TOOLS) {
      const m = b.policy.matrix;
      if (!m) continue;
      if ('none' in m) {
        if (!m.none.trim()) bad.push(`${b.slug}: none with no reason`);
        continue;
      }
      const props = (b.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      if (!(m.param in props)) bad.push(`${b.slug}: ${m.param} is not in its schema`);
      if (!GUIDE_ACTIONS.includes(m.action)) bad.push(`${b.slug}: ${m.action} is no guide action`);
      for (const k of m.kinds ?? []) {
        if (!ITEM_KIND_NAMES.includes(k)) bad.push(`${b.slug}: ${k} is no kind`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the item-id argument shapes the plan names', () => {
    for (const p of ['id', 'ids', 'node_id', 'file_id', 'note_ids']) {
      expect(ITEM_ID_PARAM.test(p), p).toBe(true);
    }
    for (const p of ['idea', 'slug', 'map', 'identity'])
      expect(ITEM_ID_PARAM.test(p), p).toBe(false);
  });

  it('the read patterns see each way of reading it, and no declaration', () => {
    const reads = [
      'const m = def.policy.matrix;',
      'const m = policy?.matrix;',
      "const m = policy['matrix'];",
      "if ('matrix' in policy) return;",
      'const { matrix } = policy;',
      'const { effect, matrix: m } = policy;',
      'const f = ({ matrix }) => matrix;',
      'function f({ matrix }: ToolPolicy) {}',
    ];
    for (const src of reads)
      expect(
        MATRIX_READ.some((re) => re.test(src)),
        src,
      ).toBe(true);
    const declarations = [
      "policy: { matrix: { none: 'names no item' }, effect: 'write' },",
      "  matrix: { action: 'read', param: 'id', kinds: ['page'] },",
      'matrix?: ToolMatrix;',
      '// the matrix test',
    ];
    for (const src of declarations) {
      expect(
        MATRIX_READ.some((re) => re.test(code(src))),
        src,
      ).toBe(false);
    }
  });

  it('no product code reads it: the gate never asks it (not a pre-check)', () => {
    // A read of a policy's matrix field: `.matrix` after a name, a
    // subscript (`['matrix']`), an `in` test, or a destructuring (`{ matrix }`
    // or `{ matrix: m }` before `=`, or as a parameter). Allowed in the
    // declaration's own module (its type), the A8 test support, and tests.
    const allowed = new Set([
      'packages/tools/src/tool-policy.ts',
      'packages/db/src/matrix/test-support/a8-tool-cells.ts',
    ]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const rel = relative(ROOT, p);
          if (allowed.has(rel)) continue;
          const src = readFileSync(p, 'utf8');
          if (MATRIX_READ.some((re) => re.test(code(src)))) hits.push(rel);
        }
      }
    };
    for (const d of ['packages', 'server']) walk(join(ROOT, d));
    expect(hits).toEqual([]);
  });
});
