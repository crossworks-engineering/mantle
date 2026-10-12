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
/** A run's owner surface, with the run's login when it has one (A0 fix
 *  round, M1). */
const OWNER_RUN =
  /surface: run\.loginId\s*\?\s*\{ kind: 'owner', via: 'run', loginId: run\.loginId \}\s*:\s*\{ kind: 'owner', via: 'run' \}/;
const INHERIT_CTX = /\.\.\.\(ctx\.surface \? \{ surface: ctx\.surface \} : \{\}\)/;

const SITES: Record<string, Site> = {
  // ── owner paths: an explicit owner surface ──
  'packages/mcp-core/src/register/context.ts': {
    calls: 1,
    // `surface` is MCP_OWNER_SURFACE (owner/mcp), or owner/federation for a
    // peer bound to the owner (MCP as a login): built before the call.
    surface:
      /const surface: ToolSurface = via === 'mcp' \? MCP_OWNER_SURFACE : \{ kind: 'owner', via \}/,
    scope: 'file',
    why: 'MCP holds the owner credential (owner/mcp, or owner/federation for a peer)',
  },
  // ── a member's or client's own MCP login ──
  'packages/mcp-core/src/login-surface.ts': {
    calls: 1,
    surface: /surface: \{\s+kind: 'owner',/,
    scope: 'call',
    why: "a connector call on a login's own MCP (W7b: every login's) runs on the owner surface, in that login's scope, its login and connection stamped",
  },
  'packages/tools/src/pending.ts': {
    calls: 1,
    // The approving login rides along when the path names one (W6b fix
    // round 3, L-2): server-set, never from model arguments.
    surface:
      /surface: \{\s*kind: 'owner',\s*via: 'pending',\s*\.\.\.\(opts\?\.approverLoginId \? \{ loginId: opts\.approverLoginId \} : \{\}\),?\s*\}/,
    scope: 'call',
    why: 'an Admin user approves a pending call, on the owner surface',
  },
  'server/web/lib/runs/execute-item.ts': {
    calls: 1,
    surface: OWNER_RUN,
    scope: 'call',
    why: "a run item is the owner's own queued work",
  },
  'server/api/src/workflows/runs-worker-turn.ts': {
    calls: 1,
    surface: OWNER_RUN,
    scope: 'call',
    why: "a run worker turn is the owner's own work",
  },
  'packages/runtime/src/assistant/run-turn.ts': {
    calls: 1,
    // With the signed-in login (W6b fix round 2, M-2): app_delete reads it.
    surface:
      /surface: \{ kind: 'web', \.\.\.\(options\?\.loginId \? \{ loginId: options\.loginId \} : \{\}\) \}/,
    scope: 'call',
    why: "the owner's web /assistant turn",
  },
  'packages/runtime/src/assistant/run-sim-turn.ts': {
    calls: 1,
    // The MCP connection's login rides along (W7c fix round 1, M1).
    surface:
      /surface: opts\.loginId \? \{ kind: 'web', loginId: opts\.loginId \} : \{ kind: 'web' \}/,
    scope: 'call',
    why: "ask_responder: the owner's simulated web turn",
  },
  'server/api/src/agent/telegram/turn.ts': {
    calls: 1,
    // A workspace assistant's chat is a team surface (W7d fix round 1, M1),
    // carrying its chat for a run's report (W7d+e); the Admin assistant's
    // and a helper's keep the telegram surface.
    surface:
      /surface: workspaceTurn\s*\? \{ kind: 'team', loginId, privateReads, originTelegramChatId: row\.telegramChatId \}\s*: \{\s*kind: 'telegram',/,
    scope: 'call',
    why: "a Telegram chat: its paired user's (a workspace assistant's on a team surface)",
  },
  'packages/runtime/src/heartbeats/fire.ts': {
    calls: 1,
    // The Telegram chat only when the fire answers the anchor (W7
    // integration fix 3, F1: telegramChat is null for any other login).
    surface:
      /: telegramChat && pairedTelegram\s*\? \{\s*kind: 'telegram',\s*telegramChatId: telegramChat,[^}]*accountId: pairedTelegram\.accountId,\s*\}\s*: \{ kind: 'web' \}/,
    scope: 'call',
    why: "the owner's heartbeat, on its telegram or web surface",
  },
  'server/api/src/workflows/runs-resume-turn.ts': {
    calls: 1,
    // resumeSurface: a team surface for a run of any workspace but Admin
    // (W7c fix round 2), its Telegram-origin run too (W7d fix round 1, M1),
    // checked first whatever the login (W7d+e: none names no login);
    // else the origin Telegram chat (naming the run's login, the chat's own
    // user, W7d, and its bot), else the run's login on the web, else the web
    // with none. Built before the call.
    surface:
      /if \(workspaceId\) \{[\s\S]*if \(!ws\?\.isAdmin\) \{\s*return \{\s*kind: 'team',\s*\.\.\.\(loginId \? \{ loginId \} : \{\}\),\s*privateReads: false,[\s\S]*kind: 'telegram',\s*telegramChatId: originChannel\.chat_id,\s*\.\.\.\(chat \? \{ accountId: chat\.accountId \} : \{\}\),\s*\.\.\.\(loginId \? \{ loginId \} : \{\}\),[\s\S]*if \(!loginId\) return \{ kind: 'web' \};[\s\S]*return \{ kind: 'web', loginId \};/,
    scope: 'file',
    why: "a run resuming on its origin channel, as its login (a member's run on a team surface)",
  },
  'server/web/lib/api-v1-builtin.ts': {
    calls: 1,
    surface: OWNER('api'),
    scope: 'call',
    why: 'the public API v1 (table rows): the route checked an admin first (getOwnerOr401)',
  },
  'server/web/app/api/dev-tools/execute-tool/route.ts': {
    calls: 1,
    surface: /surface: \{ kind: 'web', loginId: user\.actor\.id \}/,
    scope: 'call',
    why: "the owner's dev tool console, naming its signed-in login",
  },
  'server/web/app/api/apps/[id]/tool-broker/route.ts': {
    calls: 1,
    surface: /surface: scope\.surface/,
    scope: 'call',
    why: "the owner's own app: appToolScope, web for an admin-level app, the app level's surface below it (client tier audit L1)",
  },
  // ── someone else: their surface, explicitly ──
  'packages/runtime/src/assistant/run-team-turn.ts': {
    calls: 1,
    // { kind: 'team', loginId, ... } (client chat went in W5c)
    surface: /surface: \{\s*kind: 'team',/,
    scope: 'call',
    why: "a member's chat turn: always the team surface, never the owner",
  },
  'server/web/lib/app-runner.ts': {
    calls: 1,
    surface: /surface: scope\.surface/,
    scope: 'call',
    why: "a member's app call (the owner and the deprecated member tool broker, W7e): appToolScope at the team rules, never the owner",
  },
  'server/web/app/s/[token]/tool-broker/route.ts': {
    calls: 1,
    surface: /surface: \{ kind: 'contact', contactId, shareId: share\.id \}/,
    scope: 'call',
    why: "a contact link's call of an External access tool: the contact surface, never the owner",
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
  'packages/tools/src/builtins-apps.ts': {
    calls: 1,
    // The same ctx object, untouched: the surface is the caller's.
    surface: /def\.handler\(input, ctx\)/,
    scope: 'call',
    why: "the author ceiling (W7b) wraps an app tool's own handler for a user outside Admin and passes its ctx on unchanged",
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
