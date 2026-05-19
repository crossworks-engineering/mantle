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
import { HEARTBEAT_TOOLS } from './tools';
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

describe('heartbeat_complete — context guard', () => {
  it('refuses cleanly when called outside a heartbeat fire', async () => {
    const r = await callOutsideContext('heartbeat_complete', { reason: 'oops' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/only callable from inside a heartbeat fire/i);
    }
  });

  it('the error names the tool so the LLM can correct course', async () => {
    const r = await callOutsideContext('heartbeat_complete', {});
    if (!r.ok) expect(r.error).toMatch(/heartbeat_complete/);
  });
});

describe('heartbeat_snooze — context + arg guards', () => {
  it('refuses outside a heartbeat fire', async () => {
    const r = await callOutsideContext('heartbeat_snooze', { for_hours: 1 });
    expect(r.ok).toBe(false);
  });

  it('inside context: rejects when neither for_hours nor until is provided', async () => {
    const r = await callInsideContext('heartbeat_snooze', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/for_hours.*until/);
  });

  it('inside context: rejects for_hours <= 0', async () => {
    const r = await callInsideContext('heartbeat_snooze', { for_hours: 0 });
    expect(r.ok).toBe(false);
  });

  it('inside context: rejects unparseable until', async () => {
    const r = await callInsideContext('heartbeat_snooze', { until: 'next tuesday' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid until/i);
  });
});

describe('heartbeat_update_state — context + patch shape', () => {
  it('refuses outside a heartbeat fire', async () => {
    const r = await callOutsideContext('heartbeat_update_state', { patch: { x: 1 } });
    expect(r.ok).toBe(false);
  });

  it('inside context: rejects a non-object patch (array)', async () => {
    const r = await callInsideContext('heartbeat_update_state', { patch: [1, 2, 3] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/plain object/);
  });

  it('inside context: rejects a non-object patch (string)', async () => {
    const r = await callInsideContext('heartbeat_update_state', { patch: 'hello' });
    expect(r.ok).toBe(false);
  });

  it('inside context: rejects a missing patch', async () => {
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
