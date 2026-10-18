/**
 * The A8 coverage (plan v3.2 section 5 item 4; S11a: tools and kinds, the
 * routes come with S11b), no database: every registry kind is in the grid
 * or in A8_EXEMPT with a reason, and every tool is in a generated cell set
 * (a8-tool-cells.ts, from its matrix declaration) or exempt (its declaration
 * is `none`, with a reason). What is in neither is uncovered.
 *
 * Two pins in scripts/arch-scoreboard.pins.json: a8Uncovered (only down)
 * and a8Exempt (capped at its count when S11a made it; a new exemption is
 * reviewed by the final audit and raises the cap with a note). The tool
 * cells run with a database in a8-tool-cells.matrix.test.ts; this test also
 * holds their size to a ceiling (the budget: pairwise keeps it bounded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { A8_KINDS } from '@mantle/db/matrix/a8-grid';
import {
  A8_EXEMPT,
  A8_TOOL_MODES,
  A8_TOOL_SURFACES,
  a8ToolDecl,
  a8ToolPlan,
  a8UncoveredKinds,
  type A8ToolDef,
} from '@mantle/db/matrix/a8-tool-cells';
import { BUILTIN_TOOLS, MCP_SURFACE_POLICIES } from '@mantle/tools';
import { HEARTBEAT_TOOLS } from '../../../packages/runtime/src/heartbeats/tools';

const PINS = join(__dirname, '../../../scripts/arch-scoreboard.pins.json');

/** The tool cells' size ceiling: cells x ways in x check modes. A new tool
 *  adds its pairwise cells; past this the matrix run is too slow for CI. */
const A8_TOOL_RUN_CEILING = 9000;

/** Every tool: the builtins, the heartbeat tools, and the MCP surface's own
 *  (a name a builtin has is the builtin's). */
function allTools(): A8ToolDef[] {
  const builtins = [...BUILTIN_TOOLS, ...HEARTBEAT_TOOLS] as unknown as A8ToolDef[];
  const names = new Set(builtins.map((b) => b.slug));
  const own = Object.entries(MCP_SURFACE_POLICIES)
    .filter(([slug]) => !names.has(slug))
    .map(([slug, policy]) => ({ slug, policy }) as unknown as A8ToolDef);
  return [...builtins, ...own];
}

/** The A8 counts S11a pins (a8Uncovered, a8Exempt), and what makes them. */
function a8Counts() {
  const plan = a8ToolPlan(allTools().map(a8ToolDecl));
  const kindsUncovered = a8UncoveredKinds();
  return {
    plan,
    kindsUncovered,
    a8Uncovered: Object.keys(plan.uncovered).length + kindsUncovered.length,
    a8Exempt: Object.keys(plan.exempt).length + Object.keys(A8_EXEMPT).length,
  };
}

describe('A8 coverage: every kind and tool is in a cell set or exempt', () => {
  const counts = a8Counts();

  it('every registry kind is in the grid or exempt with a reason', () => {
    expect(counts.kindsUncovered).toEqual([]);
    for (const [kind, why] of Object.entries(A8_EXEMPT)) {
      expect(ITEM_KIND_NAMES, kind).toContain(kind);
      expect(A8_KINDS, kind).not.toContain(kind);
      expect(why.trim(), kind).not.toBe('');
    }
  });

  it('every tool with a matrix action has cells, and each write action its member-negatives', () => {
    expect(counts.plan.uncovered).toEqual({});
    const writes = new Set(
      counts.plan.cells
        .filter((c) => !['read', 'list', 'search'].includes(c.action))
        .map((c) => c.tool),
    );
    for (const tool of writes) {
      const negatives = counts.plan.cells.filter((c) => c.tool === tool && c.mandatory);
      expect(negatives.length, `${tool}: its member-negative cells`).toBeGreaterThanOrEqual(2);
    }
  });

  it('the pins: a8Uncovered only down, a8Exempt at its cap', () => {
    const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, number>;
    const msg = (key: 'a8Uncovered' | 'a8Exempt') =>
      `${key} is ${counts[key]}, pinned ${pins[key]}: lower the pin when it went down; ` +
      'a raise needs a review line from the final audit in _notes';
    expect(counts.a8Uncovered, msg('a8Uncovered')).toBe(pins.a8Uncovered);
    expect(counts.a8Exempt, msg('a8Exempt')).toBe(pins.a8Exempt);
  });

  it('the budget: the tool cells stay under their ceiling', () => {
    const runs = counts.plan.cells.length * A8_TOOL_SURFACES.length * A8_TOOL_MODES.length;
    expect(runs).toBeLessThanOrEqual(A8_TOOL_RUN_CEILING);
  });
});
