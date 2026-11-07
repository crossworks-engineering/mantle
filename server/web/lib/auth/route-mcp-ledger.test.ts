/**
 * The owner's rule (2026-11-06): whatever a person can do in the client, their
 * agent can do through MCP, for every call that is logical and useful. The
 * route rows and the MCP surface are two lists, so they drift silently. This
 * test holds them together: every route row has one line in
 * route-mcp-ledger.json, and that line says how an agent does it.
 *
 *   "POST /api/notes": "note_create"             a tool does it (or a list)
 *   "PATCH /api/pages/:id": { "tool": "page_update", "gap": "no width" }
 *                                                a tool does most of it
 *   "POST /api/users": { "planned": "user_create" }   an approved tool, not built
 *   "GET /api/shell": { "none": "why" }          no tool: not useful, or machinery
 *   "POST /api/auth/login": { "people": "harm" } a person only, for a stated harm
 *
 * It also holds the rights rule: a person's agent gets no more than that
 * person's rights. Where a route's rule and its tool's gate differ, the line in
 * `rightsDiffer` says why, so a new difference fails here until someone looks.
 *
 * It reads three snapshots that their own tests pin, so it needs no database
 * and no box. It proves that a tool is named, not that the tool does the whole
 * job, and it reads the gate's scope only, not an item check inside a handler.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Row = {
  class: string;
  area?: string;
  open?: string;
  logins?: string;
  public?: boolean;
};
type Scope = 'any' | 'admin' | 'admin-kind' | { area: string } | null | undefined;
type Line =
  | string
  | string[]
  | { tool: string | string[]; gap: string }
  | { planned: string; note?: string }
  | { none: string }
  | { people: string };
type Ledger = { routes: Record<string, Line>; rightsDiffer: Record<string, string> };

/** Grows only with an owner's word and a stated harm: the list stays small. */
const PEOPLE_ONLY_ROWS = 24;

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;

const rows = readJson<Record<string, Row>>('./__snapshots__/route-policy.rows.json');
const toolNames = new Set(
  readJson<Array<{ name: string }>>(
    // The HTTP list: stdio alone adds the brain's own shell (run_terminal).
    '../../../../packages/mcp-core/src/__snapshots__/tools-list.http.json',
  ).map((t) => t.name),
);
const decisions = readJson<Record<string, { gate?: { scope?: Scope } | null }>>(
  '../../../../packages/mcp-core/src/__snapshots__/surface-decisions.json',
);
const ledger = readJson<Ledger>('./route-mcp-ledger.json');

const routeKeys = Object.keys(rows).filter((key) => !key.startsWith('HEAD '));
const lines = Object.entries(ledger.routes);

const toolsOf = (line: Line): string[] => {
  if (typeof line === 'string') return [line];
  if (Array.isArray(line)) return line;
  return 'tool' in line ? [line.tool].flat() : [];
};

/** How a route's rule and its tool's gate differ, or null. */
function rightsDifference(row: Row, scope: Scope): 'area' | 'wider' | 'narrower' | null {
  // No login asks a public row, so a tool cannot reach further than it.
  if (row.public) return null;
  const adminOnly = scope === 'admin' || scope === 'admin-kind';
  const areaScope = scope && typeof scope === 'object' ? scope.area : null;
  if (row.area) {
    // The gate asks an Admin scope only that the login holds Admin, not the
    // route's area, so the tool reaches further than the route.
    if (scope === 'any' || adminOnly) return 'wider';
    return areaScope && areaScope !== row.area ? 'area' : null;
  }
  if (row.open === 'login') return adminOnly || areaScope ? 'narrower' : null;
  if (row.class !== 'content' && row.class !== 'self') return null;
  // Admin only by hand.
  if (areaScope) return 'narrower';
  return scope === 'any' ? 'wider' : null;
}

/** Every tool line whose gate differs from its route: `route|tool|kind`. The
 *  kind is in the key, so a difference that gets worse fails too. */
function differences(): string[] {
  const found: string[] = [];
  for (const [key, line] of lines) {
    const row = rows[key];
    if (!row) continue;
    for (const tool of toolsOf(line)) {
      const kind = rightsDifference(row, decisions[tool]?.gate?.scope);
      if (kind) found.push(`${key}|${tool}|${kind}`);
    }
  }
  return found.sort();
}

describe('every route has a way for an agent, or a stated reason', () => {
  it('has one line for every route row, and none for a route that went', () => {
    const missing = routeKeys.filter((key) => !(key in ledger.routes));
    // A new route: add its line to route-mcp-ledger.json. Name the tool, or
    // say { "planned": tool }, { "none": why } or { "people": harm }.
    expect(missing).toEqual([]);
    const stale = lines.map(([key]) => key).filter((key) => !rows[key] || key.startsWith('HEAD '));
    expect(stale).toEqual([]);
  });

  it('keeps the lines sorted, so two branches rarely touch the same place', () => {
    const keys = lines.map(([key]) => key);
    expect(keys).toEqual([...keys].sort());
  });

  it('names only tools that are on the MCP surface, each with a gate', () => {
    const unknown = lines.flatMap(([key, line]) =>
      toolsOf(line)
        .filter((tool) => !toolNames.has(tool) || !decisions[tool]?.gate?.scope)
        .map((tool) => `${key} -> ${tool}`),
    );
    expect(unknown).toEqual([]);
  });

  it('names something on every line', () => {
    const empty = lines.flatMap(([key, line]) => {
      if (typeof line === 'object' && !Array.isArray(line) && !('tool' in line)) {
        return 'planned' in line && !/^[a-z][a-z0-9_]+$/.test(line.planned) ? [key] : [];
      }
      return toolsOf(line).length === 0 ? [key] : [];
    });
    expect(empty).toEqual([]);
  });

  it('moves a planned tool to its route line once the tool exists', () => {
    const built = lines.flatMap(([key, line]) =>
      typeof line === 'object' && 'planned' in line && toolNames.has(line.planned)
        ? [`${key} -> ${line.planned}`]
        : [],
    );
    expect(built).toEqual([]);
  });

  it('gives a real reason for every gap and every route with no tool', () => {
    const empty = lines.flatMap(([key, line]) => {
      if (typeof line !== 'object' || Array.isArray(line) || 'planned' in line) return [];
      const reason = 'none' in line ? line.none : 'people' in line ? line.people : line.gap;
      return reason.trim().length < 5 ? [key] : [];
    });
    expect(empty).toEqual([]);
  });

  it('keeps the people-only list small', () => {
    const people = lines.filter(
      ([, line]) => typeof line === 'object' && !Array.isArray(line) && 'people' in line,
    );
    expect(people).toHaveLength(PEOPLE_ONLY_ROWS);
  });
});

describe("a person's agent gets no more than that person's rights", () => {
  it('names a reason for every route whose tool gate differs from it', () => {
    // A new line here means a tool's gate and its route disagree. Fix the gate,
    // or add the line to `rightsDiffer` with the reason it is right.
    expect(differences()).toEqual(Object.keys(ledger.rightsDiffer).sort());
  });

  it('gives each difference a real reason', () => {
    const empty = Object.entries(ledger.rightsDiffer).filter(([, why]) => why.trim().length < 5);
    expect(empty).toEqual([]);
  });

  it('reads the difference the way the rule means it', () => {
    const row = (over: Partial<Row>): Row => ({ class: 'content', ...over });
    const area = row({ class: 'area', area: 'users' });
    expect(rightsDifference(row({ class: 'public' }), 'any')).toBeNull();
    expect(rightsDifference(row({ class: 'link' }), 'any')).toBeNull();
    expect(rightsDifference(row({ class: 'self', public: true }), 'any')).toBeNull();
    expect(rightsDifference(row({}), 'any')).toBe('wider');
    expect(rightsDifference(row({}), 'admin')).toBeNull();
    expect(rightsDifference(row({}), { area: 'users' })).toBe('narrower');
    expect(rightsDifference(row({ class: 'self' }), 'any')).toBe('wider');
    expect(rightsDifference(row({ open: 'login' }), 'any')).toBeNull();
    expect(rightsDifference(row({ open: 'login' }), 'admin')).toBe('narrower');
    expect(rightsDifference(row({ open: 'login' }), 'admin-kind')).toBe('narrower');
    expect(rightsDifference(row({ open: 'login' }), { area: 'users' })).toBe('narrower');
    expect(
      rightsDifference(row({ class: 'self', open: 'login', logins: 'any' }), 'any'),
    ).toBeNull();
    expect(rightsDifference(area, 'any')).toBe('wider');
    expect(rightsDifference(area, 'admin')).toBe('wider');
    expect(rightsDifference(area, 'admin-kind')).toBe('wider');
    expect(rightsDifference(area, { area: 'users' })).toBeNull();
    expect(rightsDifference(area, { area: 'keys' })).toBe('area');
  });
});
