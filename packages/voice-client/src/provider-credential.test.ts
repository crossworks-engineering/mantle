import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_WORKSPACE_ID_MAX,
  credentialOf,
  normalizeAnthropicWorkspaceId,
} from './provider-credential';

// Placeholder strings only: never a real key.

describe('credentialOf', () => {
  it("copies only the credential's own fields", () => {
    const route = {
      adapter: {},
      model: 'm',
      baseUrl: 'http://x',
      apiKey: 'test-key',
      anthropicWorkspaceId: 'wrkspc_a',
    };
    expect(credentialOf(route)).toEqual({ apiKey: 'test-key', anthropicWorkspaceId: 'wrkspc_a' });
    expect(credentialOf({ apiKey: 'test-key' })).toEqual({ apiKey: 'test-key' });
    expect(credentialOf({ apiKey: 'k', anthropicWorkspaceId: '' })).toEqual({ apiKey: 'k' });
  });
});

describe('normalizeAnthropicWorkspaceId', () => {
  it('trims, and reads empty as none', () => {
    expect(normalizeAnthropicWorkspaceId('  wrkspc_abc  ')).toEqual({
      ok: true,
      value: 'wrkspc_abc',
    });
    expect(normalizeAnthropicWorkspaceId('   ')).toEqual({ ok: true, value: null });
    expect(normalizeAnthropicWorkspaceId(null)).toEqual({ ok: true, value: null });
  });

  it('takes ASCII letters, digits, _ and - only, up to the cap', () => {
    for (const ok of ['wrkspc_01ABC', 'any-shape_123', 'x'.repeat(ANTHROPIC_WORKSPACE_ID_MAX)]) {
      expect(normalizeAnthropicWorkspaceId(ok).ok, ok).toBe(true);
    }
    for (const bad of [
      'a b',
      'a\nb',
      'a\tb',
      'wrkspc_é',
      'wrkspc_中',
      'wrkspc_\u0085',
      'wrkspc_\u009f',
      'wrkspc_\u0000',
      'wrkspc.x',
      'wrkspc/x',
      'x'.repeat(ANTHROPIC_WORKSPACE_ID_MAX + 1),
    ]) {
      expect(normalizeAnthropicWorkspaceId(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
