import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTHROPIC_WORKSPACE_ID_MAX,
  _clearProviderKeyContexts,
  normalizeAnthropicWorkspaceId,
  providerKeyContext,
  rememberProviderKeyContext,
} from './provider-key-context';

// Placeholder strings only: never a real key.
const KEY = 'test-key-value-not-real';

afterEach(() => _clearProviderKeyContexts());

describe('provider key context', () => {
  it('remembers what a key carries and forgets it when cleared', () => {
    expect(providerKeyContext(KEY)).toBeUndefined();
    rememberProviderKeyContext(KEY, { anthropicWorkspaceId: 'wrkspc_test' });
    expect(providerKeyContext(KEY)).toEqual({ anthropicWorkspaceId: 'wrkspc_test' });
    rememberProviderKeyContext(KEY, null);
    expect(providerKeyContext(KEY)).toBeUndefined();
    rememberProviderKeyContext(KEY, { anthropicWorkspaceId: 'wrkspc_test' });
    rememberProviderKeyContext(KEY, {});
    expect(providerKeyContext(KEY)).toBeUndefined();
  });

  it('answers nothing for an empty or missing key', () => {
    rememberProviderKeyContext('', { anthropicWorkspaceId: 'x' });
    expect(providerKeyContext('')).toBeUndefined();
    expect(providerKeyContext(null)).toBeUndefined();
    expect(providerKeyContext(undefined)).toBeUndefined();
  });

  it('stays bounded, oldest out first', () => {
    for (let i = 0; i < 600; i += 1) {
      rememberProviderKeyContext(`k-${i}`, { anthropicWorkspaceId: `w-${i}` });
    }
    expect(providerKeyContext('k-0')).toBeUndefined();
    expect(providerKeyContext('k-599')).toEqual({ anthropicWorkspaceId: 'w-599' });
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

  it('refuses what could never be a header value, and nothing else', () => {
    expect(normalizeAnthropicWorkspaceId('a b').ok).toBe(false);
    expect(normalizeAnthropicWorkspaceId('a\nb').ok).toBe(false);
    expect(normalizeAnthropicWorkspaceId('x'.repeat(ANTHROPIC_WORKSPACE_ID_MAX + 1)).ok).toBe(
      false,
    );
    // No format is invented: any other shape is the owner's to give.
    expect(normalizeAnthropicWorkspaceId('any-shape_123').ok).toBe(true);
  });
});
