/**
 * The owner-regression sweep (client logins C4, plan section 8, tests 15).
 *
 * Since C4 a missing surface is NOT the owner: dispatchTool refuses every
 * ownerOnly builtin to a call without one, and the read tools hide the
 * private corpus from it. So every path that runs tools for the owner must
 * name its surface, and every path that runs them for someone else must
 * pass that someone on. This test finds EVERY call site that can run a tool
 * (dispatchTool, runToolLoop, runResponderLoop, and the MCP server's direct
 * `def.handler`) in packages/ and server/, and fails when:
 *   - a call site appears that is not in the table below (add it, with the
 *     surface it passes and why), or one in the table disappears;
 *   - a call site stops passing the surface the table says it passes.
 * Behavioural tests pin the same for the paths that can run without a DB:
 * owner-only-gate.test.ts (recipe steps), builtins-delegation.test.ts and
 * runtime invoke-agent.surface.test.ts (delegation), and mcp-core
 * context.owner.test.ts (MCP).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

type Site = {
  /** How many call sites the file holds. */
  calls: number;
  /** What each call must pass. Matched against the call's own argument text,
   *  or the whole file when the context is built before the call. */
  surface: RegExp;
  scope: 'call' | 'file';
  why: string;
};

const OWNER = (via: string) => new RegExp(`surface: \\{ kind: 'owner', via: '${via}' \\}`);
const INHERIT_CTX = /\.\.\.\(ctx\.surface \? \{ surface: ctx\.surface \} : \{\}\)/;

const SITES: Record<string, Site> = {
  // ── owner paths: an explicit owner surface ──
  'packages/mcp-core/src/register/context.ts': {
    calls: 1,
    surface: /surface: MCP_OWNER_SURFACE/,
    scope: 'call',
    why: 'MCP holds the owner credential (owner/mcp)',
  },
  'packages/tools/src/pending.ts': {
    calls: 1,
    surface: OWNER('pending'),
    scope: 'call',
    why: 'only the owner approves a pending call',
  },
  'server/web/lib/runs/execute-item.ts': {
    calls: 1,
    surface: OWNER('run'),
    scope: 'call',
    why: "a run item is the owner's own queued work",
  },
  'server/api/src/workflows/runs-worker-turn.ts': {
    calls: 1,
    surface: OWNER('run'),
    scope: 'call',
    why: "a run worker turn is the owner's own work",
  },
  'packages/runtime/src/assistant/run-turn.ts': {
    calls: 1,
    surface: /surface: \{ kind: 'web' \}/,
    scope: 'call',
    why: "the owner's web /assistant turn",
  },
  'packages/runtime/src/assistant/run-sim-turn.ts': {
    calls: 1,
    surface: /surface: \{ kind: 'web' \}/,
    scope: 'call',
    why: "ask_responder: the owner's simulated web turn",
  },
  'server/api/src/agent/telegram/turn.ts': {
    calls: 1,
    surface: /surface: \{\s*kind: 'telegram',/,
    scope: 'call',
    why: "the owner's Telegram chat",
  },
  'packages/runtime/src/heartbeats/fire.ts': {
    calls: 1,
    surface:
      /\? \{ kind: 'telegram', telegramChatId: hb\.surface\.chat_id \}\s*: \{ kind: 'web' \}/,
    scope: 'call',
    why: "the owner's heartbeat, on its telegram or web surface",
  },
  'server/api/src/workflows/runs-resume-turn.ts': {
    calls: 1,
    surface:
      /\? \{ kind: 'telegram', telegramChatId: run\.originChannel\.chat_id \}\s*: \{ kind: 'web' \}/,
    scope: 'call',
    why: "the owner's run resuming on its origin channel",
  },
  'server/web/app/api/dev-tools/execute-tool/route.ts': {
    calls: 1,
    surface: /surface: \{ kind: 'web' \}/,
    scope: 'call',
    why: "the owner's dev tool console",
  },
  'server/web/app/api/apps/[id]/tool-broker/route.ts': {
    calls: 1,
    surface: /surface: \{ kind: 'web' \}/,
    scope: 'call',
    why: "the owner's own app",
  },
  // ── someone else: their surface, explicitly ──
  'packages/runtime/src/assistant/run-team-turn.ts': {
    calls: 1,
    surface: /surface: \{\s*kind: 'team',/,
    scope: 'call',
    why: "a member login's chat turn (team, never the owner)",
  },
  'server/web/app/api/member/apps/[id]/tool-broker/route.ts': {
    calls: 1,
    surface: /surface: \{\s*kind: 'team',/,
    scope: 'call',
    why: "a member's app call (team, never the owner)",
  },
  // ── pass-through: the caller's surface, unchanged ──
  'packages/tools/src/dispatch.ts': {
    calls: 1,
    surface: INHERIT_CTX,
    scope: 'file',
    why: "a recipe step runs for the recipe's caller (subCtx)",
  },
  'packages/tools/src/toolsmith/recipes.ts': {
    calls: 1,
    surface: INHERIT_CTX,
    scope: 'call',
    why: 'recipe_tool_test runs for whoever asked for the test',
  },
  'packages/tools/src/toolsmith/api-tools.ts': {
    calls: 1,
    surface: INHERIT_CTX,
    scope: 'call',
    why: 'api_tool_test runs for whoever asked for the test',
  },
  'packages/runtime/src/assistant/responder-loop.ts': {
    calls: 1,
    surface: /surface: opts\.surface/,
    scope: 'call',
    why: 'the shared responder loop threads its caller surface',
  },
  'packages/runtime/src/agent/tool-loop/execute-call.ts': {
    calls: 1,
    surface: /\.\.\.\(args\.surface \? \{ surface: args\.surface \} : \{\}\)/,
    scope: 'call',
    why: 'the tool loop threads its caller surface into every tool call',
  },
  'packages/runtime/src/agent/invoke-agent.ts': {
    calls: 1,
    surface: /\.\.\.\(surface \? \{ surface \} : \{\}\)/,
    scope: 'call',
    why: 'a delegated child runs on the surface invoke_agent hands it (childSurface)',
  },
};

/** A call that can run a tool: the entry points, or the MCP direct call. */
const CALL = /\b(dispatchTool|runToolLoop|runResponderLoop)\(|\bdef\.handler\(/g;
const DEFINITION = /\bfunction (dispatchTool|runToolLoop|runResponderLoop)\(/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.turbo']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
      out.push(p);
  }
  return out;
}

/** The text of each call from its name to the matching close paren. */
function callsIn(src: string): string[] {
  const out: string[] = [];
  const lines = src.split('\n');
  let offset = 0;
  const skip = new Set<number>();
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || DEFINITION.test(t)) {
      for (let i = 0; i < line.length; i++) skip.add(offset + i);
    }
    offset += line.length + 1;
  }
  for (const m of src.matchAll(CALL)) {
    if (skip.has(m.index!)) continue;
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index!, end + 1));
  }
  return out;
}

describe('every call site that runs a tool names its surface', () => {
  const found = new Map<string, { src: string; calls: string[] }>();
  for (const top of ['packages', 'server']) {
    for (const file of sourceFiles(join(ROOT, top))) {
      const src = readFileSync(file, 'utf8');
      const calls = callsIn(src);
      if (calls.length) found.set(relative(ROOT, file), { src, calls });
    }
  }

  it('the table lists exactly the call sites in the tree', () => {
    const counts = Object.fromEntries([...found].map(([f, v]) => [f, v.calls.length]));
    const expected = Object.fromEntries(Object.entries(SITES).map(([f, s]) => [f, s.calls]));
    expect(counts).toEqual(expected);
  });

  it.each(Object.entries(SITES))('%s passes its surface', (file, site) => {
    const got = found.get(file);
    expect(got, `${file} has no call site any more`).toBeDefined();
    if (site.scope === 'file') {
      expect(got!.src).toMatch(site.surface);
    } else {
      for (const call of got!.calls) expect(call, site.why).toMatch(site.surface);
    }
  });
});
