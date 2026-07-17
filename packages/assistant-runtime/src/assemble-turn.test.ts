/**
 * Unit tests for the shared responder-turn assembly (audit #5c) — the
 * drift-prone middle all three conversational surfaces now run through.
 * Collaborators are mocked at their module boundaries; these tests pin the
 * assembly CONTRACT: prompt composition + gating, volatile ordering, the
 * heartbeat affordance, the loop-override clamps, and the image-routing pair.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({
  identity: '' as string,
  identityError: null as Error | null,
  openHeartbeats: [] as Array<{ slug: string; name: string; state: Record<string, unknown> }>,
  openHeartbeatsError: null as Error | null,
  hasHeartbeats: false,
  resolvedToolSlugs: [] as string[][],
  visionOk: true,
  maxImageBytes: 1000,
  catalogWarms: 0,
  thinkingBudget: 2048,
}));

vi.mock('@mantle/agent-runtime', () => ({
  composeSystemPromptWithSkills: (prompt: string, skills: Array<{ slug: string }>) =>
    skills.length > 0 ? `${prompt}\n\n[skills:${skills.map((s) => s.slug).join(',')}]` : prompt,
  effectiveToolSlugs: (groups: Array<{ toolSlugs: string[] }>) =>
    groups.flatMap((g) => g.toolSlugs),
  resolveAgentSkills: vi.fn(async (_owner: string, slugs: string[]) =>
    slugs.map((slug) => ({ slug })),
  ),
  resolveAgentToolGroups: vi.fn(async (_owner: string, slugs: string[]) =>
    slugs.map((slug) => ({ slug, toolSlugs: [`${slug}-tool-a`, `${slug}-tool-b`] })),
  ),
  resolveAgentTools: vi.fn(async (_owner: string, slugs: string[]) => {
    h.resolvedToolSlugs.push(slugs);
    return slugs.map((slug) => ({ slug }));
  }),
}));

vi.mock('@mantle/content', () => ({
  buildIdentityContext: vi.fn(async () => {
    if (h.identityError) throw h.identityError;
    return h.identity;
  }),
  buildTimeContextLine: () => 'TIME-LINE',
  resolveThinkingBudget: () => h.thinkingBudget,
}));

vi.mock('@mantle/heartbeats', () => ({
  buildOpenHeartbeatContext: (open: Array<{ slug: string }>) =>
    open.length > 0 ? `HEARTBEAT-BLOCK(${open.map((o) => o.slug).join(',')})` : '',
  HEARTBEAT_RESPONDER_TOOLS: ['heartbeat_update_state', 'heartbeat_complete', 'heartbeat_snooze'],
  hasActiveHeartbeatsOnSurface: vi.fn(async () => h.hasHeartbeats),
  openHeartbeatsForSurface: vi.fn(async () => {
    if (h.openHeartbeatsError) throw h.openHeartbeatsError;
    return h.openHeartbeats;
  }),
}));

vi.mock('@mantle/tracing', () => ({
  maxImageBytesFor: () => h.maxImageBytes,
  modelSupportsVision: () => h.visionOk,
  refreshModelCatalog: vi.fn(async () => {
    h.catalogWarms++;
  }),
}));

import {
  assembleResponderTurn,
  base64Bytes,
  decideImageRouting,
  runWithImageFallback,
} from './assemble-turn';

function agent(overrides: Record<string, unknown> = {}): Agent {
  return {
    id: 'agent-1',
    ownerId: 'owner-1',
    slug: 'saskia',
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    systemPrompt: 'PERSONA',
    skillSlugs: [],
    toolGroupSlugs: [],
    memoryConfig: {},
    params: {},
    ...overrides,
  } as unknown as Agent;
}

const BASE = {
  ownerId: 'owner-1',
  prefs: { timezone: 'Africa/Johannesburg', locale: 'en-GB' },
  logPrefix: '[test]',
} as const;

beforeEach(() => {
  h.identity = '';
  h.identityError = null;
  h.openHeartbeats = [];
  h.openHeartbeatsError = null;
  h.hasHeartbeats = false;
  h.resolvedToolSlugs = [];
  h.visionOk = true;
  h.maxImageBytes = 1000;
  h.catalogWarms = 0;
  h.thinkingBudget = 2048;
});

describe('assembleResponderTurn — prompt composition', () => {
  it('cached prefix = identity + skills prompt + suffix; volatile = time + extras + heartbeat', async () => {
    h.identity = 'IDENTITY';
    h.openHeartbeats = [{ slug: 'hb-1', name: 'HB', state: {} }];
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({ skillSlugs: ['recall'] }),
      systemPromptSuffix: '\n\nAUDIO-TAGS',
      volatileExtras: ['LOCATION-LINE', '', null, 'TZ-NOTE'],
      heartbeatSurface: { kind: 'web' },
    });
    expect(a.effectiveSystemPrompt).toBe('IDENTITY\n\nPERSONA\n\n[skills:recall]\n\nAUDIO-TAGS');
    // Ordering matters: time line first, extras in caller order, heartbeat
    // block last. Falsy extras are dropped.
    expect(a.volatileContext).toBe(
      'TIME-LINE\n\nLOCATION-LINE\n\nTZ-NOTE\n\nHEARTBEAT-BLOCK(hb-1)',
    );
    expect(a.relatedHeartbeatSlugs).toEqual(['hb-1']);
  });

  it('memory_config.inject_journal=false skips the identity block', async () => {
    h.identity = 'IDENTITY';
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({ memoryConfig: { inject_journal: false } }),
    });
    expect(a.effectiveSystemPrompt).toBe('PERSONA');
  });

  it('includeIdentity=false (team isolation) never calls the identity builder', async () => {
    h.identity = 'IDENTITY';
    const { buildIdentityContext } = await import('@mantle/content');
    (buildIdentityContext as ReturnType<typeof vi.fn>).mockClear();
    const a = await assembleResponderTurn({ ...BASE, agent: agent(), includeIdentity: false });
    expect(a.effectiveSystemPrompt).toBe('PERSONA');
    expect(buildIdentityContext).not.toHaveBeenCalled();
  });

  it('identity + heartbeat lookups are best-effort — failures never sink the turn', async () => {
    h.identityError = new Error('journal query blew up');
    h.openHeartbeatsError = new Error('heartbeats down');
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent(),
      heartbeatSurface: { kind: 'web' },
    });
    expect(a.effectiveSystemPrompt).toBe('PERSONA');
    expect(a.volatileContext).toBe('TIME-LINE');
    expect(a.relatedHeartbeatSlugs).toEqual([]);
  });
});

describe('assembleResponderTurn — tools', () => {
  it('resolves group tools and injects the heartbeat affordance only when active', async () => {
    h.hasHeartbeats = true;
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({ toolGroupSlugs: ['memory-core'] }),
      heartbeatSurface: { kind: 'telegram', chatId: '777' },
    });
    expect(a.allowedTools.map((t) => t.slug)).toEqual([
      'memory-core-tool-a',
      'memory-core-tool-b',
      'heartbeat_update_state',
      'heartbeat_complete',
      'heartbeat_snooze',
    ]);
  });

  it('no heartbeat surface (team) → no heartbeat queries, no affordance', async () => {
    h.hasHeartbeats = true; // would inject if the surface were passed
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({ toolGroupSlugs: ['memory-core'] }),
    });
    expect(a.allowedTools.map((t) => t.slug)).toEqual(['memory-core-tool-a', 'memory-core-tool-b']);
  });

  it('excludeToolSlugs (team private-reads gate) strips before resolution', async () => {
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({ toolGroupSlugs: ['team-read'] }),
      excludeToolSlugs: ['team-read-tool-b'],
    });
    expect(h.resolvedToolSlugs[0]).toEqual(['team-read-tool-a']);
    expect(a.allowedTools.map((t) => t.slug)).toEqual(['team-read-tool-a']);
  });
});

describe('assembleResponderTurn — budgets, delegation, loop overrides', () => {
  it('clamps max_iterations to 30, forwards tool-volume caps raw', async () => {
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({
        memoryConfig: { max_iterations: 50, max_tool_calls: 40, max_calls_per_tool: 9 },
      }),
    });
    expect(a.loopOverrides).toEqual({
      maxIterations: 30,
      maxToolCallsPerTurn: 40,
      maxCallsPerToolPerTurn: 9,
    });
  });

  it('non-positive / absent overrides are omitted (runToolLoop defaults apply)', async () => {
    const a = await assembleResponderTurn({
      ...BASE,
      agent: agent({ memoryConfig: { max_iterations: 0 } }),
    });
    expect(a.loopOverrides).toEqual({});
  });

  it('withThinking=false (team) suppresses the owner thinking budget', async () => {
    const on = await assembleResponderTurn({ ...BASE, agent: agent() });
    const off = await assembleResponderTurn({ ...BASE, agent: agent(), withThinking: false });
    expect(on.thinkingBudget).toBe(2048);
    expect(off.thinkingBudget).toBeUndefined();
  });

  it('allowDelegation=false (team fail-closed) empties delegate_to', async () => {
    const cfg = { memoryConfig: { delegate_to: ['researcher'] } };
    const on = await assembleResponderTurn({ ...BASE, agent: agent(cfg) });
    const off = await assembleResponderTurn({ ...BASE, agent: agent(cfg), allowDelegation: false });
    expect(on.delegateTo).toEqual(['researcher']);
    expect(off.delegateTo).toEqual([]);
  });
});

describe('decideImageRouting', () => {
  const base = { model: 'm', hasImage: true, imageBytes: 500, hasTranscript: false };

  it('routes the raw image only when: image, no transcript, vision model, within limit', () => {
    expect(decideImageRouting({ ...base, logPrefix: '[t]' })).toBe(true);
  });

  it('no image → false, and the model catalog is not warmed', () => {
    expect(decideImageRouting({ ...base, hasImage: false, logPrefix: '[t]' })).toBe(false);
    expect(h.catalogWarms).toBe(0);
  });

  it('a usable transcript wins over raw pixels (transcript-default)', () => {
    expect(decideImageRouting({ ...base, hasTranscript: true, logPrefix: '[t]' })).toBe(false);
    expect(h.catalogWarms).toBe(1); // warmed for next time even on the text path
  });

  it('non-vision model → false', () => {
    h.visionOk = false;
    expect(decideImageRouting({ ...base, logPrefix: '[t]' })).toBe(false);
  });

  it('oversized image → false (the pre-Bedrock size guard)', () => {
    expect(decideImageRouting({ ...base, imageBytes: 1001, logPrefix: '[t]' })).toBe(false);
  });
});

describe('runWithImageFallback', () => {
  it('no image → straight to the text path, not flagged as a retry', async () => {
    const withImage = vi.fn();
    const textOnly = vi.fn(async (retry: boolean) => ({ retry }));
    const r = await runWithImageFallback({
      canSeeImage: false,
      logPrefix: '[t]',
      withImage,
      textOnly,
    });
    expect(withImage).not.toHaveBeenCalled();
    expect(r).toEqual({ retry: false });
  });

  it('image success → single attempt', async () => {
    const textOnly = vi.fn();
    const r = await runWithImageFallback({
      canSeeImage: true,
      logPrefix: '[t]',
      withImage: async () => 'ok',
      textOnly,
    });
    expect(r).toBe('ok');
    expect(textOnly).not.toHaveBeenCalled();
  });

  it('image failure → one text-only retry flagged retryAfterImageError', async () => {
    const r = await runWithImageFallback({
      canSeeImage: true,
      logPrefix: '[t]',
      withImage: async () => {
        throw new Error('Could not process image');
      },
      textOnly: async (retry) => ({ retry }),
    });
    expect(r).toEqual({ retry: true });
  });
});

describe('base64Bytes', () => {
  it('decodes plain and data-URL base64 sizes without allocating', () => {
    const bytes = Buffer.from('hello world!'); // 12 bytes
    const b64 = bytes.toString('base64');
    expect(base64Bytes(b64)).toBe(12);
    expect(base64Bytes(`data:image/png;base64,${b64}`)).toBe(12);
    expect(base64Bytes(Buffer.from('hi').toString('base64'))).toBe(2); // padded
    expect(base64Bytes('')).toBe(0);
  });
});
