/**
 * The hand-written MCP tools as definitions (A5 step 2, mcp-defs.ts): each
 * carries a policy of the declared shape; the eleven that share a builtin's
 * name carry the builtin's policy, with the arguments its item checks name
 * mapped to the MCP twin's own; each takes its policy from the surface table
 * (@mantle/tools mcp-surface-policies.ts, where the Admin gate reads the two
 * responder writes); and registration reads the definitions.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_TOOL_SLUGS,
  MCP_SURFACE_POLICIES,
  getBuiltin,
  type McpSurfaceSlug,
  type ToolPolicy,
} from '@mantle/tools';
import { registerMantleTools } from './build-server';
import { MCP_TOOL_DEFS, mcpDefinition } from './mcp-defs';
import { mcpDefinitionSet } from './mcp-policy';
import { MCP_HANDWRITTEN_READ_ONLY } from './login-surface';

/** Per twin, an MCP argument name and the builtin's for the same thing,
 *  where they differ. None does today for an argument a policy names (the
 *  twins differ in what else they take: a path for a folder, an `id`). */
const ARG_NAMES: Record<string, Record<string, string>> = {};

/** `p` with its item checks' arguments renamed from the MCP twin's to the
 *  builtin's. */
function mappedToBuiltin(slug: string, p: ToolPolicy): ToolPolicy {
  const names = ARG_NAMES[slug] ?? {};
  if (!Array.isArray(p.items)) return p;
  return {
    ...p,
    items: p.items.map((t) => ({ ...t, param: names[t.param] ?? t.param })),
  };
}

const TWINS = MCP_TOOL_DEFS.filter((d) => getBuiltin(d.slug));

describe('the MCP definitions (A5 step 2)', () => {
  it('sixteen, eleven of them twins of a builtin', () => {
    expect(MCP_TOOL_DEFS).toHaveLength(16);
    expect(TWINS.map((d) => d.slug).sort()).toEqual(
      [
        'file_get',
        'file_read',
        'file_rename',
        'folder_describe',
        'folder_rename',
        'page_get',
        'page_list',
        'table_get',
        'table_list',
        'table_rows_list',
        'tree_list',
      ].sort(),
    );
  });

  it('each has a policy of the declared shape', () => {
    for (const d of MCP_TOOL_DEFS) {
      const p = d.policy;
      expect(['read', 'write'], d.slug).toContain(p.effect);
      expect(['none', 'model', 'ownerKey'], d.slug).toContain(p.spends);
      expect(
        typeof p.scope === 'object' || ['any', 'admin', 'admin-kind'].includes(p.scope),
        d.slug,
      ).toBe(true);
      if (p.startsModelWork) expect(p.spends, d.slug).not.toBe('none');
      if (p.creates) expect(p.effect, d.slug).toBe('write');
      // An item a check names is one of the tool's own arguments.
      if (Array.isArray(p.items)) {
        for (const t of p.items) expect(Object.keys(d.shape), d.slug).toContain(t.param);
      }
      expect(Object.isFrozen(d), d.slug).toBe(true);
      expect(Object.isFrozen(d.policy), d.slug).toBe(true);
      if (Array.isArray(d.policy.items)) {
        expect(Object.isFrozen(d.policy.items), d.slug).toBe(true);
        for (const t of d.policy.items) expect(Object.isFrozen(t), d.slug).toBe(true);
      }
    }
  });

  it("a twin's policy is the builtin's, its arguments mapped", () => {
    for (const d of TWINS) {
      const builtin = getBuiltin(d.slug)!;
      expect(mappedToBuiltin(d.slug, d.policy), d.slug).toEqual(builtin.policy);
      if (Array.isArray(builtin.policy.items)) {
        const props = Object.keys(
          (builtin.inputSchema.properties ?? {}) as Record<string, unknown>,
        );
        for (const t of builtin.policy.items) expect(props, d.slug).toContain(t.param);
      }
    }
  });

  it('takes each policy from the surface table by name; the Admin gate holds the two responder writes', () => {
    // The same names, each definition holding the table's own policy object
    // (fix round 1, LOW-1: @mantle/tools loads the table in every process;
    // packages/tools/src/admin-gate.test.ts pins the Admin gate without
    // this package).
    expect(MCP_TOOL_DEFS.map((d) => d.slug).sort()).toEqual(
      Object.keys(MCP_SURFACE_POLICIES).sort(),
    );
    for (const d of MCP_TOOL_DEFS) {
      expect(d.policy, d.slug).toBe(MCP_SURFACE_POLICIES[d.slug as McpSurfaceSlug]);
    }
    expect(ADMIN_ONLY_TOOL_SLUGS.has('responder_turn_input')).toBe(true);
    expect(ADMIN_ONLY_TOOL_SLUGS.has('responder_turn_record')).toBe(true);
    expect(ADMIN_ONLY_TOOL_SLUGS.has('ask_responder')).toBe(false);
    expect(ADMIN_ONLY_TOOL_SLUGS.has('search')).toBe(false);
  });

  it('registration reads the table: every definition, once, under its own name', () => {
    for (const transport of ['stdio', 'http'] as const) {
      const names: string[] = [];
      const descriptions = new Map<string, string>();
      const capture = {
        registerTool: (name: string, config: { description: string }) => {
          names.push(name);
          descriptions.set(name, config.description);
        },
      };
      registerMantleTools(capture as never, 'owner-1', { transport });
      for (const d of MCP_TOOL_DEFS) {
        expect(
          names.filter((n) => n === d.slug),
          d.slug,
        ).toHaveLength(1);
        expect(descriptions.get(d.slug), d.slug).toBe(mcpDefinition(d.slug)!.description);
      }
    }
  });

  it("a view of the definitions is read only, Set.prototype's add too (fix round 1, LOW-2)", () => {
    const reads = MCP_TOOL_DEFS.filter((d) => d.policy.effect === 'read').map((d) => d.slug);
    for (const view of [
      MCP_HANDWRITTEN_READ_ONLY,
      mcpDefinitionSet((d) => d.policy.effect === 'read'),
    ]) {
      expect(view).not.toBeInstanceOf(Set);
      expect(() => Set.prototype.add.call(view as Set<string>, 'page_delete')).toThrow(TypeError);
      expect(() => Set.prototype.delete.call(view as Set<string>, 'search')).toThrow(TypeError);
      expect(() => Set.prototype.clear.call(view as Set<string>)).toThrow(TypeError);
      expect(() => (view as Set<string>).add('page_delete')).toThrow(TypeError);
      expect(Object.isFrozen(view)).toBe(true);
      // Still read like a Set, and nothing changed.
      expect([...view].sort()).toEqual([...reads].sort());
      expect(view.size).toBe(reads.length);
      expect(view.has('search')).toBe(true);
      expect(view.has('page_delete')).toBe(false);
    }
  });
});
