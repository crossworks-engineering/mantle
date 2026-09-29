/**
 * The lowering guard's classification (client logins C5 audit fixes, L2 and
 * I1) without a database: every built-in write tool is classified, every
 * field a rule reads exists on the tool, and the verdicts that need no
 * lookup. The lookups (an item's level, an app's tables, a group's level)
 * run on Postgres in packages/runtime/src/agent/client-sourced-gate.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

// Any lookup fails: a verdict of "run" below proves the call needed none.
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    select: () => {
      throw new Error('no database in this test');
    },
  },
}));

import { listBuiltins, isBuiltinReadOnly } from './registry';
import {
  clientSourcedGate,
  toolCreatesNodes,
  WRITE_RULES,
  writeRuleFor,
  type GateTool,
} from './client-sourced-rules';

const TOOLS = listBuiltins();
const ID = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
const builtin = (slug: string): GateTool => ({ slug, handler: { kind: 'builtin', ref: slug } });
const verdict = (slug: string, input: Record<string, unknown>, tool = builtin(slug)) =>
  clientSourcedGate({ ownerId: 'o', tool, input, isReadOnlyBuiltin: isBuiltinReadOnly });

describe('every built-in write tool is classified (the sweep)', () => {
  it('no builtin that is not readOnly is missing from WRITE_RULES', () => {
    const missing = TOOLS.filter((t) => t.readOnly !== true && !writeRuleFor(t.slug)).map(
      (t) => t.slug,
    );
    expect(missing).toEqual([]);
  });

  it('every rule names a registered builtin (no stale entries)', () => {
    const known = new Set(TOOLS.map((t) => t.slug));
    expect(Object.keys(WRITE_RULES).filter((s) => !known.has(s))).toEqual([]);
  });

  it('every field a rule reads is a field of the tool (no typo leaves a target unchecked)', () => {
    const wrong: string[] = [];
    for (const t of TOOLS) {
      const rule = writeRuleFor(t.slug);
      if (rule?.kind !== 'write') continue;
      const props = Object.keys(
        ((t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}) as object,
      );
      for (const f of [
        ...(rule.nodes ?? []),
        ...(rule.agents ?? []),
        ...(rule.groups ?? []),
        ...(rule.tools ?? []),
        ...(rule.apps ?? []),
      ]) {
        if (!props.includes(f)) wrong.push(`${t.slug}.${f}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the lowering tools are the lowering rule', () => {
    for (const slug of ['access_set', 'node_share', 'page_share', 'email_page']) {
      expect(writeRuleFor(slug)).toEqual({ kind: 'lowering' });
    }
  });

  it('the copy tools make nodes that carry the mark (L10)', () => {
    for (const slug of [
      'page_from_note',
      'page_extract_section',
      'page_split',
      'note_create',
      'note_from_page',
      'table_from_text',
      'page_create',
    ]) {
      expect(toolCreatesNodes(builtin(slug)), slug).toBe(true);
    }
    expect(toolCreatesNodes(builtin('page_update'))).toBe(false);
    expect(toolCreatesNodes({ slug: 'x', handler: { kind: 'recipe', steps: [] } })).toBe(false);
  });
});

describe('verdicts that need no lookup', () => {
  it('reads run; a builtin write the guard does not know waits', async () => {
    expect(await verdict('page_get', { id: ID })).toEqual({ gate: false });
    expect(await verdict('task_get', { id: ID })).toEqual({ gate: false });
    const unknown = await clientSourcedGate({
      ownerId: 'o',
      tool: builtin('brand_new_write'),
      input: {},
      isReadOnlyBuiltin: () => false,
    });
    expect(unknown.gate).toBe(true);
  });

  it('a lowering waits; access_set to team or admin runs', async () => {
    expect((await verdict('access_set', { node_id: ID, level: ' Client ' })).gate).toBe(true);
    expect((await verdict('page_share', { id: ID })).gate).toBe(true);
    expect(await verdict('access_set', { node_id: ID, level: 'team' })).toEqual({ gate: false });
  });

  it('a target named by anything but an id waits (fail closed)', async () => {
    expect((await verdict('page_update', { id: 'Pricing page' })).gate).toBe(true);
    expect((await verdict('table_row_add', { table_id: 42 })).gate).toBe(true);
    expect(
      (await verdict('page_from_notes', { note_ids: [ID, 7], supersede_source: true })).gate,
    ).toBe(true);
  });

  it('a file overwrite by path waits; a new file runs', async () => {
    expect(
      (await verdict('file_create', { parent_path: 'a', filename: 'b', overwrite: true })).gate,
    ).toBe(true);
    expect(await verdict('file_create', { parent_path: 'a', filename: 'b' })).toEqual({
      gate: false,
    });
  });

  it('a create with no parent runs; the always-rules wait; the free ones run', async () => {
    expect(await verdict('note_create', { title: 't', content: 'c' })).toEqual({ gate: false });
    expect(await verdict('page_create', { title: 't' })).toEqual({ gate: false });
    expect((await verdict('run_plan', { title: 't' })).gate).toBe(true);
    expect((await verdict('run_terminal', { command: 'ls' })).gate).toBe(true);
    expect(await verdict('web_fetch', { url: 'https://example.com' })).toEqual({ gate: false });
    expect(await verdict('invoke_agent', { agent_slug: 'x', prompt: 'p' })).toEqual({
      gate: false,
    });
  });

  it('a lookup that fails sends the call to pending', async () => {
    const v = await verdict('page_update', { id: ID });
    expect(v).toEqual({ gate: true, why: 'the target check failed' });
  });

  it('a row slug that differs from its builtin is judged by the builtin', async () => {
    const renamed: GateTool = { slug: 'my_reader', handler: { kind: 'builtin', ref: 'page_get' } };
    expect(await verdict('my_reader', { id: ID }, renamed)).toEqual({ gate: false });
    const renamedWrite: GateTool = {
      slug: 'my_plan',
      handler: { kind: 'builtin', ref: 'run_plan' },
    };
    expect((await verdict('my_plan', {}, renamedWrite)).gate).toBe(true);
  });
});
