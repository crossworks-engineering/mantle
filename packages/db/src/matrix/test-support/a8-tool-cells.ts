/**
 * The A8 tool cells (workspaces arch plan v3.2, S11a; section 5 item 2): a
 * set of cells for every tool whose policy declares a matrix action
 * (@mantle/tools tool-policy.ts ToolMatrix), generated from that
 * declaration, and judged against the guide oracle (../guide-oracle.ts) by
 * the action the tool declares.
 *
 * For each tool: its candidates are the six GUIDE_ROLES x the fixture's
 * placements x the kinds it takes (the workspace kinds of A8_KINDS), at its
 * one action; a pairwise pick of them, salted with the tool's name (so a new
 * tool adds its own cells and moves no other tool's); and, for a write
 * action, the member-negative cells whatever the pick (plan rule 5): the
 * outsider, the read grant's member, and a member with Write on a sibling
 * item (writeGrant on the Admin-homed item), each refused with no row
 * changed. A cell whose caller does not read the item is also refused in the
 * words a random uuid gets (the answer byte-equal, the id aside).
 *
 * The declaration states intent only: no gate reads it. These cells run the
 * product's own paths, the turn's dispatchTool and the MCP surface, in check
 * modes warn and on (server/web/server/a8-tool-cells.matrix.test.ts), and
 * the coverage test (server/web/server/a8-coverage.test.ts) counts what no
 * cell covers. This module is pure: no database, no tools package (it takes
 * the tools as data, so @mantle/db imports nothing above it).
 */
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import {
  GUIDE_PLACEMENTS,
  GUIDE_ROLES,
  TURN_WORKSPACE,
  expectedAccess,
  guideStanding,
  type GuideAction,
  type GuideActor,
  type GuideAnswer,
  type GuidePlacement,
  type GuideRole,
  type GuideSurface,
} from '../guide-oracle';
import { A8_KINDS, cellName, stableKey, type A8Cell } from './a8-grid';

/** Why a kind of a class the grid does not hold is exempt (the workspace
 *  class is the grid's: A8_KINDS). A class not named here is uncovered. */
const EXEMPT_CLASS: Readonly<Record<string, string>> = {
  admin_only: 'an Admin-only kind: only Admin users read it, no grant to ask',
  conversation: 'a conversation kind: read through its chat, not a grant',
};

/** The registry kinds the A8 grid makes no item of, each with why (plan
 *  v3.2 section 5 item 1: every kind is in the grid or here), by its class.
 *  A new kind of the workspace class is in the grid by itself (A8_KINDS
 *  reads the registry); a new Admin-only kind raises a8Exempt past its cap
 *  (the coverage test), which the final audit reviews; a new class is
 *  uncovered until it is named in EXEMPT_CLASS. */
export const A8_EXEMPT: Readonly<Record<string, string>> = Object.fromEntries(
  ITEM_KIND_NAMES.flatMap((k) => {
    const why = EXEMPT_CLASS[ITEM_KINDS[k].class];
    return why ? [[k, why] as const] : [];
  }),
);

/** The registry kinds neither in the grid nor exempt (the coverage cell). */
export function a8UncoveredKinds(): string[] {
  return ITEM_KIND_NAMES.filter((k) => !A8_KINDS.includes(k) && !(k in A8_EXEMPT));
}

/** An argument that names an item, by its name (plan v3.2 section 5 item 2:
 *  id, *_id, node_id, ids). */
export const ITEM_ID_PARAM = /^(id|ids|node_id|[a-z0-9_]+_id|[a-z0-9_]+_ids)$/;

/** A tool as the cells read it: its policy's matrix and what else decides
 *  a cell (the tools package hands these in). */
export type A8ToolDecl = {
  slug: string;
  effect: 'read' | 'write';
  matrix?: Readonly<
    { action: GuideAction; param: string; kinds?: readonly string[] } | { none: string }
  >;
  inputSchema: Record<string, unknown>;
  /** Its Admin step is not `any`: a scope that holds no Admin is refused. */
  adminStep: boolean;
  /** It has no tool row (MCP only): a turn cannot call it. */
  mcpOnly: boolean;
  /** An allowed call needs a model or the outside, which the matrix stubs
   *  (cost safety): only its refused cells run. */
  stubbed: boolean;
};

/** The ways in a tool cell runs through: a turn (dispatchTool in the
 *  assistant's turn scope) and the one MCP surface (an OAuth connection). */
export const A8_TOOL_SURFACES: readonly { surface: GuideSurface; actor: GuideActor }[] = [
  { surface: 'web-turn', actor: 'turn' },
  { surface: 'mcp-oauth', actor: 'login' },
];

/** The check modes the tool cells run in (rising, as the surface cells). */
export const A8_TOOL_MODES = ['warn', 'on'] as const;

export type A8ToolCell = A8Cell & {
  tool: string;
  param: string;
  /** A member-negative cell (plan rule 5), run whatever the pick. */
  mandatory?: true;
};

export type A8ToolPlan = {
  cells: A8ToolCell[];
  /** The tools with cells. */
  covered: string[];
  /** A tool that declares an action and gets no cell, or a read taking an
   *  item id with no declaration, or a write with none: and why. */
  uncovered: Record<string, string>;
  /** A tool that declares `none`: why (the a8Exempt count). */
  exempt: Record<string, string>;
  /** The candidates the oracle has no answer for, by reason. */
  na: Record<string, number>;
};

const READS: readonly GuideAction[] = ['read', 'list', 'search'];
const props = (schema: Record<string, unknown>) =>
  ((schema as { properties?: Record<string, unknown> }).properties ?? {}) as Record<
    string,
    { type?: unknown }
  >;

/** The item-id arguments a tool's schema takes. */
export function itemIdParams(schema: Record<string, unknown>): string[] {
  return Object.keys(props(schema)).filter((p) => ITEM_ID_PARAM.test(p));
}

/** The member-negative placements of a write action, by role (rule 5). */
const NEGATIVES: readonly { role: GuideRole; placement: GuidePlacement; create?: true }[] = [
  { role: 'outsider', placement: 'root' },
  { role: 'readGrant', placement: 'root' },
  { role: 'writeGrant', placement: 'admin' },
  { role: 'outsider', placement: 'folder', create: true },
  { role: 'readGrant', placement: 'folder', create: true },
];

/** The oracle's answer for a candidate, as a login on MCP: the one the
 *  pick filters with (the not-applicable reasons do not depend on the way
 *  in for the actions a tool declares). */
const loginAnswer = (role: GuideRole, kind: string, placement: GuidePlacement, a: GuideAction) =>
  expectedAccess({ surface: 'mcp-oauth', placement, actor: 'login' }, role, kind, a);

/** Every tool's cells, from its declaration alone. */
export function a8ToolPlan(
  tools: readonly A8ToolDecl[],
  kinds: readonly string[] = A8_KINDS,
): A8ToolPlan {
  const plan: A8ToolPlan = { cells: [], covered: [], uncovered: {}, exempt: {}, na: {} };
  const sorted = [...tools].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const t of sorted) {
    const m = t.matrix;
    if (!m) {
      if (t.effect === 'write') plan.uncovered[t.slug] = 'a write with no matrix declaration';
      else if (itemIdParams(t.inputSchema).length) {
        plan.uncovered[t.slug] =
          `a read taking ${itemIdParams(t.inputSchema).join(', ')} with no matrix declaration`;
      }
      continue;
    }
    if ('none' in m) {
      plan.exempt[t.slug] = m.none;
      continue;
    }
    if (!(m.param in props(t.inputSchema))) {
      plan.uncovered[t.slug] = `its matrix names ${m.param}, which its schema does not take`;
      continue;
    }
    const its = (m.kinds ?? kinds).filter((k) => kinds.includes(k));
    if (!its.length) {
      plan.uncovered[t.slug] = `none of its kinds (${(m.kinds ?? []).join(', ')}) is in the grid`;
      continue;
    }
    const candidates: A8Cell[] = [];
    for (const role of GUIDE_ROLES) {
      for (const kind of its) {
        for (const placement of GUIDE_PLACEMENTS) {
          if (m.action === 'create' && placement !== 'folder') {
            plan.na['a tool create names its folder: the folder placement only'] =
              (plan.na['a tool create names its folder: the folder placement only'] ?? 0) + 1;
            continue;
          }
          const want = loginAnswer(role, kind, placement, m.action);
          if ('na' in want) {
            plan.na[want.na] = (plan.na[want.na] ?? 0) + 1;
            continue;
          }
          candidates.push({ actor: 'login', role, kind, placement, action: m.action });
        }
      }
    }
    const picked: A8ToolCell[] = candidates.map((c) => ({ ...c, tool: t.slug, param: m.param }));
    if (!READS.includes(m.action)) {
      const kind = its[0]!;
      for (const n of NEGATIVES) {
        if ((m.action === 'create') !== (n.create === true)) continue;
        const want = loginAnswer(n.role, kind, n.placement, m.action);
        if ('na' in want || ('allow' in want && want.allow)) continue;
        const c: A8ToolCell = {
          actor: 'login',
          role: n.role,
          kind,
          placement: n.placement,
          action: m.action,
          tool: t.slug,
          param: m.param,
          mandatory: true,
        };
        const same = picked.find((x) => cellName(x) === cellName(c));
        if (same) same.mandatory = true;
        else picked.push(c);
      }
    }
    if (!picked.length) {
      plan.uncovered[t.slug] = 'its declaration gives no cell the oracle answers';
      continue;
    }
    plan.covered.push(t.slug);
    plan.cells.push(...picked);
  }
  plan.cells = a8ToolPairwise(plan.cells);
  return plan;
}

/**
 * The pairwise pick of the tool cells (plan v3.2 section 5 item 6: pairwise
 * bounds the matrix): every pair of values of two dimensions (tool, role,
 * kind, placement) some candidate holds is held by a picked cell, and every
 * member-negative cell is picked. So each tool meets every role and every
 * placement it has an answer for, and every kind it takes. The candidates
 * are taken in the order of a hash of the tool's name and the cell's (salted
 * by the tool, so a new tool adds the cells its own pairs need and moves an
 * old tool's only where it already holds a pair that cell was picked for).
 */
function a8ToolPairwise(cells: readonly A8ToolCell[]): A8ToolCell[] {
  const pairsOf = (c: A8ToolCell) => {
    const d = [`t:${c.tool}`, `r:${c.role ?? '-'}`, `k:${c.kind}`, `p:${c.placement}`];
    const out: string[] = [];
    for (let i = 0; i < d.length; i++)
      for (let j = i + 1; j < d.length; j++) out.push(`${d[i]}|${d[j]}`);
    return out;
  };
  const ordered = cells
    .map((c) => ({ c, name: `${c.tool} ${cellName(c)}` }))
    .map((x) => ({ ...x, key: stableKey(x.name) }))
    .sort(
      (a, b) =>
        Number(b.c.mandatory === true) - Number(a.c.mandatory === true) ||
        a.key - b.key ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  const covered = new Set<string>();
  const picked: A8ToolCell[] = [];
  for (const { c } of ordered) {
    const pairs = pairsOf(c);
    if (!c.mandatory && pairs.every((p) => covered.has(p))) continue;
    picked.push(c);
    for (const p of pairs) covered.add(p);
  }
  return picked;
}

/** A tool cell's name on a way in: `tool:<slug> <surface> <grid cell>`. A
 *  known failure names a tool cell so (a8-known-failures.ts). */
export const a8ToolCellName = (c: A8ToolCell, surface: GuideSurface) =>
  `tool:${c.tool} ${surface} ${cellName({ ...c, actor: surfaceActor(surface) })}`;

const surfaceActor = (surface: GuideSurface): GuideActor =>
  A8_TOOL_SURFACES.find((s) => s.surface === surface)?.actor ?? 'login';

/** A deny the guide gives a way in and the oracle cannot see (it knows no
 *  tools), else null. */
export function a8ToolNarrow(t: A8ToolDecl, surface: GuideSurface, role: GuideRole): string | null {
  // An Admin tool for a scope that holds no Admin (the gate's Admin step).
  if (t.adminStep && role !== 'owner' && role !== 'admin') {
    return 'an Admin tool: the scope holds no Admin';
  }
  void surface;
  return null;
}

/** The oracle's answer of a tool cell on a way in. */
export function a8ToolWant(c: A8ToolCell, surface: GuideSurface): GuideAnswer {
  return expectedAccess(
    { surface, placement: c.placement, actor: surfaceActor(surface) },
    c.role,
    c.kind,
    c.action,
  );
}

/** Whether the cell's caller reads the item (its refusal must then be a
 *  random uuid's, byte for byte). */
export function a8ToolReads(c: A8ToolCell, surface: GuideSurface): boolean {
  const role = c.role!;
  const turn = surfaceActor(surface) === 'turn';
  return guideStanding(role, c.placement, turn ? TURN_WORKSPACE[role] : null).reads;
}

/**
 * A crash, never a deny: a 5xx, a thrown error, a raw database or runtime
 * error in the reply (the mapper turns a refusal into words of its own). The
 * raw texts: a JavaScript error, a driver or query builder's ("Failed query:
 * update ..."), a Postgres message or SQLSTATE (a relation, a column, row
 * security, 42501 and its kin), a guard of the runtime's own ("withSystemTx:
 * only outside a viewer scope"), a stack frame. The one list: the surface
 * cells (a8-surfaces.matrix.test.ts) import it.
 */
export const A8_GENERIC = new RegExp(
  [
    'internal (server )?error',
    // A run item's backstop failure (execute-item.ts executeRunItem).
    'internal_error',
    'unexpected',
    'TypeError',
    'ReferenceError',
    'RangeError',
    'cannot read prop',
    'is not a function',
    'syntax error',
    'violates',
    'duplicate key',
    'does not exist',
    'permission denied for',
    'ECONN',
    'THROWN',
    // The query builder and the driver.
    'Failed query',
    'drizzle',
    'PostgresError',
    '\\bSQLSTATE\\b',
    // A Postgres error code: insufficient privilege, the integrity and
    // syntax classes, a deadlock, a lock timeout.
    '\\b(42501|42P01|42703|42883|23502|23503|23505|23514|40001|40P01|55P03|25P02)\\b',
    'current transaction is aborted',
    'invalid input syntax',
    'row-level security',
    '\\brelation "',
    '\\bcolumn "',
    // The runtime's own guards.
    'withSystemTx',
    'withScope:',
    'withTurnScope',
    'enterRequestScope',
    'only outside a viewer scope',
    // A stack frame.
    '\\n\\s*at \\S',
    '\\.(ts|js|mjs):\\d+:\\d+',
    'node_modules',
  ].join('|'),
  'i',
);

export type A8ToolOutcome = { ok: boolean; text: string; thrown?: boolean };

/** An answer with the item's id put back to a placeholder, so the hidden
 *  item's answer and a random uuid's compare byte for byte. */
const normal = (text: string, id: string) => text.split(id).join('<id>');

/**
 * Judge one tool cell: null when it passes, else why it fails. `before` and
 * `after` are the row probe's (a create: the count of the kind's new rows);
 * `random` is the same call on a random uuid, for a caller that does not
 * read the item.
 */
export function judgeA8ToolCell(a: {
  cell: A8ToolCell;
  want: { allow: true } | { allow: false; why: string };
  out: A8ToolOutcome;
  before: string;
  after: string;
  item: { id: string; title: string };
  random: { out: A8ToolOutcome; id: string } | null;
}): string | null {
  const { cell, want, out, before, after, item, random } = a;
  const changed = after !== before;
  const reads = READS.includes(cell.action);
  if (!reads && !want.allow && changed) {
    return `changed, the oracle denies (${out.text.slice(0, 100)})`;
  }
  if (out.thrown || (!out.ok && A8_GENERIC.test(out.text))) {
    return `a crash, not a refusal: ${out.text.slice(0, 160)}`;
  }
  if (want.allow) {
    if (!out.ok) return `refused, the oracle allows: ${out.text.slice(0, 160)}`;
    if (cell.action === 'delete' && after !== 'gone') return 'answered ok, not deleted';
    if (cell.action === 'create' && !changed) return 'answered ok, nothing made';
    return null;
  }
  // A caller that does not read the item gets a random uuid's answer; one
  // that reads it is refused.
  if (random) {
    const r = random.out;
    if (r.ok !== out.ok || normal(r.text, random.id) !== normal(out.text, item.id)) {
      return `not a random uuid's answer: ${out.text.slice(0, 100)} | ${r.text.slice(0, 100)}`;
    }
    return null;
  }
  if (out.ok) return `answered ok, the oracle denies (${want.why})`;
  return null;
}

/** A tool definition as the tools package has it (a builtin, or an MCP
 *  surface tool by its name and policy), read structurally. */
export type A8ToolDef = {
  slug: string;
  inputSchema?: Record<string, unknown>;
  mcpOnly?: boolean;
  policy: {
    effect: 'read' | 'write';
    matrix?: A8ToolDecl['matrix'];
    scope: unknown;
    startsModelWork?: true;
    outside?: { egress?: true; via?: string };
  };
};

/** A definition as the cells read it. */
export function a8ToolDecl(def: A8ToolDef): A8ToolDecl {
  const p = def.policy;
  return {
    slug: def.slug,
    effect: p.effect,
    ...(p.matrix ? { matrix: p.matrix } : {}),
    inputSchema: def.inputSchema ?? {},
    adminStep: p.scope !== 'any',
    mcpOnly: def.mcpOnly === true,
    stubbed: p.startsModelWork === true || p.outside?.egress === true,
  };
}
