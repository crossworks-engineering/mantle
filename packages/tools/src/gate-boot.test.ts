/**
 * The gate is ready in every process that dispatches (arch A3c fix round 2,
 * M-A). The narrowers register from @mantle/tools (gate-narrowers.ts), the
 * package server/web, server/api, the workers and the stdio MCP server all
 * load, so none fails closed for a narrower it never loaded (server/api
 * does not load @mantle/mcp-core, where three of them used to register).
 * Each process entry asks ensureGateReady() at boot, so a missing narrower
 * stops the boot, not the first tool call.
 *
 * The entry half is a SOURCE check, as recall-embed-registration.test.ts
 * is: proving it at runtime would mean booting each server.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  READ_ONLY_CALLER_ERROR,
  assertGateReady,
  gateCheck,
  loginActor,
  type GateCaller,
} from '@mantle/db';
import {
  GATE_NARROWERS,
  RISKY_TOOL_ERROR,
  ensureGateReady,
  registerGateNarrowers,
} from './gate-narrowers';
// Registers the runtime-tool source.
import './runtime-policy';
// Fills the builtin policy table.
import './registry';
import { ADMIN_ONLY_TOOL_SLUGS, isAdminOnlyTool } from './admin-gate';
import { MCP_SURFACE_POLICIES } from './mcp-surface-policies';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

describe('@mantle/tools alone makes the gate ready', () => {
  it('registers every narrower but the gate own read-only one', () => {
    expect(Object.keys(GATE_NARROWERS).sort()).toEqual(
      ['key', 'member-app', 'peer', 'spending', 'turn-caps'].sort(),
    );
    expect(() => assertGateReady()).not.toThrow();
    // Again at boot: the same functions are a no-op, never a throw.
    expect(() => registerGateNarrowers()).not.toThrow();
    expect(() => ensureGateReady()).not.toThrow();
  });

  it('@mantle/tools never imports @mantle/mcp-core (no cycle)', () => {
    const manifest = JSON.parse(read('packages/tools/package.json')) as Record<
      string,
      Record<string, string> | undefined
    >;
    expect(manifest.dependencies?.['@mantle/mcp-core']).toBeUndefined();
    expect(manifest.devDependencies?.['@mantle/mcp-core']).toBeUndefined();
    const dir = join(repoRoot, 'packages/tools/src');
    const importers = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /from\s+['"]@mantle\/mcp-core|import\(\s*['"]@mantle\/mcp-core/.test(
          readFileSync(join(dir, f), 'utf8'),
        ),
      );
    expect(importers).toEqual([]);
  });

  it("knows the MCP surface's own policies: the two responder writes are Admin only (A5 step 2 fix round 1, LOW-1)", () => {
    // No @mantle/mcp-core here (the test above): the surface table is the
    // leaf mcp-surface-policies.ts, loaded by tool-policy.ts in every
    // process, so server/api refuses them outside Admin as it did before A5.
    expect(Object.keys(MCP_SURFACE_POLICIES)).toHaveLength(16);
    for (const slug of ['responder_turn_input', 'responder_turn_record']) {
      expect(ADMIN_ONLY_TOOL_SLUGS.has(slug), slug).toBe(true);
      expect(isAdminOnlyTool(slug), slug).toBe(true);
    }
    for (const slug of ['ask_responder', 'ask_as_responder', 'search']) {
      expect(ADMIN_ONLY_TOOL_SLUGS.has(slug), slug).toBe(false);
    }
  });
});

describe('the peer narrower reads the declared mark, in any process (A5 step 2)', () => {
  // @mantle/mcp-core is not loaded here, as in server/api: the narrower
  // reads only the policy (a connector's from its row, runtime-policy.ts).
  // gate-policy.test.ts pins it, where the MCP surface is loaded, against the
  // listing today.
  const key = (over: Partial<GateCaller> = {}): GateCaller => ({
    actor: loginActor('00000000-0000-4000-8000-000000000009', 'rw'),
    via: 'key',
    admin: null,
    ...over,
  });
  const connector = {
    slug: 'mcp_crm_lookup',
    handler: { kind: 'mcp', group: 'crm', toolName: 'lookup' },
    requiresConfirm: false,
    externalAccess: null,
    description: '',
    inputSchema: {},
  };
  const api = {
    slug: 'crm_http_lookup',
    handler: { kind: 'http', method: 'GET', url: 'https://example.test/' },
    requiresConfirm: false,
    externalAccess: null,
    description: '',
    inputSchema: {},
  };
  const refOf = (row: typeof connector | typeof api) => ({
    kind: 'runtime-tool',
    name: row.slug,
    row,
  });

  it("a connector's tool is declared not risky, and a write for a key or a peer", () => {
    const ref = refOf(connector);
    expect(gateCheck(key(), ref)).toBeNull();
    expect(gateCheck(key({ via: 'peer' }), ref)).toBeNull();
    expect(gateCheck(key({ write: false }), ref)?.message).toBe(READ_ONLY_CALLER_ERROR);
    expect(gateCheck(key({ via: 'peer', write: false }), ref)?.message).toBe(
      READ_ONLY_CALLER_ERROR,
    );
  });

  it('a tool whose policy declares no peer mark is refused for a key or a peer, even named', () => {
    const ref = refOf(api);
    const named = { riskyAllowed: [api.slug] };
    for (const via of ['key', 'peer'] as const) {
      expect(gateCheck(key({ via }), ref)?.message).toBe(RISKY_TOOL_ERROR);
      expect(gateCheck(key({ via, facts: named }), ref)?.message).toBe(RISKY_TOOL_ERROR);
    }
  });

  it("the login's own OAuth and the other callers are not narrowed like a key", () => {
    for (const row of [connector, api]) {
      expect(gateCheck(key({ via: 'oauth' }), refOf(row))).toBeNull();
      expect(gateCheck(key({ via: 'turn' }), refOf(row))).toBeNull();
    }
  });
});

/** Every process entry that can reach the gate. */
const ENTRYPOINTS = [
  { file: 'server/web/server/main.ts', why: 'the HTTP routes and the owner MCP surface' },
  { file: 'server/api/src/main.ts', why: 'assistant, team and worker turns' },
  { file: 'server/mcp/src/server.ts', why: 'the stdio MCP server' },
  { file: 'server/web/workers/_runner.ts', why: 'every worker process boots through it' },
];

describe('every process entry asks ensureGateReady() at boot', () => {
  for (const { file, why } of ENTRYPOINTS) {
    it(`${file} (${why})`, () => {
      const src = read(file);
      expect(src, `${file} must call ensureGateReady() at boot`).toMatch(/ensureGateReady\(\);/);
      expect(src, `${file} must obtain ensureGateReady from the gate's package`).toMatch(
        /ensureGateReady[^;]*(from|import\()\s*['"]@mantle\/(tools\/gate-narrowers|mcp-core)['"]/,
      );
    });
  }

  it('the worker runner asks it before the worker starts', () => {
    const src = read('server/web/workers/_runner.ts');
    const run = src.slice(src.indexOf('function run('));
    expect(run.indexOf('ensureGateReady();')).toBeGreaterThan(-1);
    expect(run.indexOf('ensureGateReady();')).toBeLessThan(run.indexOf('await start();'));
  });

  it('every worker process boots through the runner', () => {
    const dir = join(repoRoot, 'server/web/workers');
    const workers = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('_'),
    );
    // Helpers, not processes.
    const helpers = new Set(['describe-error.ts', 'mask-email.ts']);
    const processes = workers.filter((f) => !helpers.has(f));
    expect(processes.length).toBeGreaterThan(0);
    for (const f of processes) {
      expect(readFileSync(join(dir, f), 'utf8'), f).toMatch(/\b(runWorker|runQueueWorker)\(/);
    }
  });
});
