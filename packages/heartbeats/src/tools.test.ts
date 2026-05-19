/**
 * Tests for the heartbeat-control tools' guard rails.
 *
 * Happy-path mutations all hit the DB and are best covered by
 * integration tests against a real Postgres. What this file pins
 * down is the LAYER above that: the refusal logic that prevents a
 * regular Saskia turn from accidentally completing or snoozing a
 * heartbeat.
 *
 * The original bug we're guarding against: if `heartbeat_complete`
 * were callable outside a fire context, an agent answering "should
 * I stop the get_to_know_user heartbeat?" could just CALL it and
 * permanently end the heartbeat. The ALS context check is the only
 * thing stopping that.
 */

import { describe, expect, it } from 'vitest';
import { HEARTBEAT_TOOLS, HEARTBEAT_RESPONDER_TOOLS } from './tools';
import { withHeartbeatContext } from './context';
import type {
  BuiltinToolDef,
  ToolHandlerContext,
  ToolHandlerResult,
} from '@mantle/tools';

const OWNER = 'owner-uuid-for-tests';
const HB_ID = 'hb-uuid-for-tests';

function findTool(slug: string): BuiltinToolDef {
  const t = HEARTBEAT_TOOLS.find((x) => x.slug === slug);
  if (!t) throw new Error(`test setup: tool '${slug}' not registered`);
  return t;
}

/** Minimal ctx that the refusal-path doesn't actually read from. */
function mkCtx(over: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
  return { ownerId: OWNER, ...over };
}

async function callOutsideContext(
  slug: string,
  input: Record<string, unknown> = {},
): Promise<ToolHandlerResult> {
  return findTool(slug).handler(input, mkCtx());
}

async function callInsideContext(
  slug: string,
  input: Record<string, unknown> = {},
): Promise<ToolHandlerResult> {
  return withHeartbeatContext({ heartbeatId: HB_ID, ownerId: OWNER }, () =>
    findTool(slug).handler(input, mkCtx()),
  );
}

describe('heartbeat_complete — addressing guard', () => {
  it('refuses cleanly when called with no slug and no fire context', async () => {
    const r = await callOutsideContext('heartbeat_complete', { reason: 'oops' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Error mentions the two valid addressing options so the LLM
      // can self-correct on retry.
      expect(r.error).toMatch(/heartbeat fire/i);
      expect(r.error).toMatch(/slug/i);
    }
  });

  // Slug-path resolution (loadOwnedHeartbeatBySlug → not found)
  // requires a live DB connection, which vitest doesn't have by
  // default. That path is exercised end-to-end by the live install;
  // see heartbeat detail page + /traces for the round-trip evidence.
});

describe('heartbeat_snooze — addressing + arg guards', () => {
  it('refuses with no slug outside a fire', async () => {
    const r = await callOutsideContext('heartbeat_snooze', { for_hours: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slug/i);
  });

  it('inside fire context: rejects when neither for_hours nor until is provided', async () => {
    const r = await callInsideContext('heartbeat_snooze', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/for_hours.*until/);
  });

  it('inside fire context: rejects for_hours <= 0', async () => {
    const r = await callInsideContext('heartbeat_snooze', { for_hours: 0 });
    expect(r.ok).toBe(false);
  });

  it('inside fire context: rejects unparseable until', async () => {
    const r = await callInsideContext('heartbeat_snooze', { until: 'next tuesday' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid until/i);
  });
});

describe('heartbeat_update_state — addressing + patch shape', () => {
  it('refuses with no slug outside a fire', async () => {
    const r = await callOutsideContext('heartbeat_update_state', { patch: { x: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slug/i);
  });

  it('rejects a non-object patch (array) — fires before addressing check', async () => {
    const r = await callInsideContext('heartbeat_update_state', { patch: [1, 2, 3] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/plain object/);
  });

  it('rejects a non-object patch (string)', async () => {
    const r = await callInsideContext('heartbeat_update_state', { patch: 'hello' });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing patch', async () => {
    const r = await callInsideContext('heartbeat_update_state', {});
    expect(r.ok).toBe(false);
  });
});

describe('heartbeat_fire — slug validation', () => {
  it('rejects an empty slug', async () => {
    const r = await callOutsideContext('heartbeat_fire', { slug: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slug required/);
  });

  it('rejects a non-string slug', async () => {
    const r = await callOutsideContext('heartbeat_fire', { slug: 42 });
    expect(r.ok).toBe(false);
  });
});

describe('HEARTBEAT_TOOLS registry shape', () => {
  it('exports exactly the 5 documented control tools', () => {
    const slugs = HEARTBEAT_TOOLS.map((t) => t.slug).sort();
    expect(slugs).toEqual([
      'heartbeat_complete',
      'heartbeat_fire',
      'heartbeat_list',
      'heartbeat_snooze',
      'heartbeat_update_state',
    ]);
  });

  it('every tool has a non-empty description (operator + LLM doc)', () => {
    for (const t of HEARTBEAT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool declares an inputSchema object', () => {
    for (const t of HEARTBEAT_TOOLS) {
      expect(t.inputSchema).toBeTypeOf('object');
      expect((t.inputSchema as { type: string }).type).toBe('object');
    }
  });
});

describe('HEARTBEAT_RESPONDER_TOOLS (auto-exclusion canonical list)', () => {
  it('is exactly the 3 responder-continuity tools', () => {
    // Pinned so a drift in the runtime exclusion never sneaks in.
    // Add/remove here is a deliberate decision — operators + the
    // seed script + the responder filter all read this constant.
    expect([...HEARTBEAT_RESPONDER_TOOLS].sort()).toEqual([
      'heartbeat_complete',
      'heartbeat_snooze',
      'heartbeat_update_state',
    ]);
  });

  it('excludes heartbeat_list (always-available operator tool)', () => {
    expect(HEARTBEAT_RESPONDER_TOOLS).not.toContain('heartbeat_list');
  });

  it('excludes heartbeat_fire (always-available operator tool)', () => {
    expect(HEARTBEAT_RESPONDER_TOOLS).not.toContain('heartbeat_fire');
  });

  it('every member of the constant is also in HEARTBEAT_TOOLS', () => {
    // No phantom slugs — every name in the auto-exclusion list must
    // correspond to an actually-registered tool.
    const registered = new Set(HEARTBEAT_TOOLS.map((t) => t.slug));
    for (const slug of HEARTBEAT_RESPONDER_TOOLS) {
      expect(registered.has(slug)).toBe(true);
    }
  });
});

describe('auto-exclusion filter behaviour (pure-logic shape)', () => {
  // The runtime filter in apps/agent + apps/web does this exact
  // computation. Pinning it here so a change to the constant
  // automatically validates the filter still produces the expected
  // shape. Doesn't touch the DB or the responder loop.
  function filterAllowlist(allowed: string[], hasActive: boolean): string[] {
    if (hasActive) return allowed;
    return allowed.filter((s) => !HEARTBEAT_RESPONDER_TOOLS.includes(s));
  }

  const baseAllowlist = [
    'search_nodes',
    'entity_search',
    'file_create',
    'heartbeat_update_state',
    'heartbeat_complete',
    'heartbeat_snooze',
    'heartbeat_list',
    'heartbeat_fire',
  ];

  it('keeps every tool when there ARE active heartbeats on the surface', () => {
    expect(filterAllowlist(baseAllowlist, true)).toEqual(baseAllowlist);
  });

  it('drops the 3 continuity tools when no active heartbeats', () => {
    const out = filterAllowlist(baseAllowlist, false);
    expect(out).not.toContain('heartbeat_update_state');
    expect(out).not.toContain('heartbeat_complete');
    expect(out).not.toContain('heartbeat_snooze');
  });

  it('keeps heartbeat_list + heartbeat_fire even with no active heartbeats', () => {
    const out = filterAllowlist(baseAllowlist, false);
    expect(out).toContain('heartbeat_list');
    expect(out).toContain('heartbeat_fire');
  });

  it('preserves non-heartbeat tools (no false positives)', () => {
    const out = filterAllowlist(baseAllowlist, false);
    expect(out).toContain('search_nodes');
    expect(out).toContain('entity_search');
    expect(out).toContain('file_create');
  });

  it('is a no-op on an allowlist that has no heartbeat tools', () => {
    const slim = ['search_nodes', 'entity_search'];
    expect(filterAllowlist(slim, false)).toEqual(slim);
  });
});
