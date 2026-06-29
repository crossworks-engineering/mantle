/**
 * Tests for the invoke_agent guardrails. These guards are the only
 * thing standing between "agent calls a peer agent for a focused task"
 * and "agent recursively spawns itself and burns the API budget by
 * lunch." Lock them down.
 *
 * Properties under test:
 *   1. Bounded depth — depth=2 chain max, no grandchildren.
 *   2. Allowlist — empty/missing list = no delegation (fail closed).
 *   3. No self-call — an agent cannot invoke itself even if its own
 *      slug is in its delegate_to list (the symptom that turns a
 *      delegation into an infinite loop bounded only by maxIterations).
 *   4. Sane error messages — every refusal explains itself well enough
 *      for an LLM to read the error and adjust its plan.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_DEPTH,
  checkAgentDepth,
  checkDelegationAllowed,
} from './invoke-agent-guards';

describe('MAX_AGENT_DEPTH constant', () => {
  it('is 2 — parent + child, no grandchildren', () => {
    // Locking this in so any future "raise to 3" decision has to
    // pass through a code review that updates this test.
    expect(MAX_AGENT_DEPTH).toBe(2);
  });
});

describe('checkAgentDepth', () => {
  it('allows the entry-point (depth=1) to invoke a child at depth=2', () => {
    const r = checkAgentDepth(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.childDepth).toBe(2);
  });

  it('refuses a child (depth=2) from invoking a grandchild', () => {
    const r = checkAgentDepth(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/depth limit/);
  });

  it('refuses deeper depths defensively', () => {
    // The invoker shouldn't ever be called this deep — but if a
    // caller routes around the dispatcher's check, the guard still
    // refuses.
    expect(checkAgentDepth(3).ok).toBe(false);
    expect(checkAgentDepth(99).ok).toBe(false);
  });

  it('rejects nonsense parent depths', () => {
    expect(checkAgentDepth(0).ok).toBe(false);
    expect(checkAgentDepth(-1).ok).toBe(false);
    expect(checkAgentDepth(1.5).ok).toBe(false);
    expect(checkAgentDepth(Number.NaN).ok).toBe(false);
  });

  it('includes the limit number in the refusal message', () => {
    const r = checkAgentDepth(2);
    if (!r.ok) expect(r.reason).toContain(`${MAX_AGENT_DEPTH}`);
  });
});

describe('checkDelegationAllowed', () => {
  it('passes when target is in the allowlist', () => {
    expect(
      checkDelegationAllowed('responder', 'researcher', ['researcher']),
    ).toEqual({ ok: true });
  });

  it('passes when target is one of several entries', () => {
    expect(
      checkDelegationAllowed('responder', 'researcher', [
        'pastoral_care',
        'researcher',
        'archivist',
      ]),
    ).toEqual({ ok: true });
  });

  it('refuses self-invocation even when slug is in the allowlist', () => {
    // The interesting case: an operator listed the parent's own slug
    // in delegate_to by accident. We refuse — self-invocation is the
    // closest thing to a recursion footgun we have once depth is past
    // the check.
    const r = checkDelegationAllowed('responder', 'responder', ['responder']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot invoke itself/);
  });

  it('nudges a self-invoke toward handling it directly or picking another specialist', () => {
    const r = checkDelegationAllowed('assistant', 'assistant', ['pages', 'assistant']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/cannot invoke itself/);
      expect(r.reason).toMatch(/directly|different specialist/i);
    }
  });

  it('refuses delegation when the allowlist is missing', () => {
    const r = checkDelegationAllowed('responder', 'researcher', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/delegation not configured/);
  });

  it('refuses delegation when the allowlist is empty', () => {
    expect(
      checkDelegationAllowed('responder', 'researcher', []).ok,
    ).toBe(false);
  });

  it('refuses delegation when the target is not in the allowlist', () => {
    const r = checkDelegationAllowed('responder', 'rogue_agent', [
      'researcher',
      'archivist',
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not in the parent's delegation allowlist/);
  });

  it('refuses an empty target slug even when allowlist contains one', () => {
    const r = checkDelegationAllowed('responder', '', ['researcher']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/agent_slug is required/);
  });

  it('names the target slug in the "not authorised" refusal so the LLM can correct', () => {
    const r = checkDelegationAllowed('responder', 'rogue', ['researcher']);
    if (!r.ok) {
      expect(r.reason).toContain('rogue');
    }
  });

  it('does not leak the full allowlist into refusal messages', () => {
    // Defence-in-depth: error strings are sent back to the LLM as
    // tool_result. Leaking the list of authorised agents is fine
    // in single-user Mantle but would matter if this surface ever
    // grows multi-tenant. Keep the message minimal — an unrelated miss
    // gets NO "did you mean", so no authorised slug is revealed.
    const r = checkDelegationAllowed('responder', 'rogue', [
      'secret_internal_agent',
      'admin_console',
    ]);
    if (!r.ok) {
      expect(r.reason).not.toContain('secret_internal_agent');
      expect(r.reason).not.toContain('admin_console');
      expect(r.reason).not.toMatch(/did you mean/i);
    }
  });

  it('suggests the closest slug on a confident near-miss (the real bug)', () => {
    // The exact failure that broke Ashley's turn: the model invented
    // 'pages-specialist' for the agent whose slug is 'pages'. Containment
    // match → suggest 'pages' so the LLM retries correctly next round.
    const r = checkDelegationAllowed('responder', 'pages-specialist', [
      'pages',
      'tables',
      'researcher',
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Did you mean 'pages'?");
    }
  });

  it('suggests on a small typo (edit distance)', () => {
    const r = checkDelegationAllowed('responder', 'resercher', ['researcher']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/did you mean 'researcher'/i);
  });

  it('reveals only ONE slug — the near-match — not the rest of the roster', () => {
    const r = checkDelegationAllowed('responder', 'page', [
      'pages',
      'secret_internal_agent',
      'admin_console',
    ]);
    if (!r.ok) {
      expect(r.reason).toContain("Did you mean 'pages'?");
      expect(r.reason).not.toContain('secret_internal_agent');
      expect(r.reason).not.toContain('admin_console');
    }
  });
});
