import { describe, expect, it } from 'vitest';
import { resolveToolLoading } from './loading';

describe('resolveToolLoading', () => {
  it("keeps an agent's own setting, whatever its role and model", () => {
    for (const set of ['full', 'deferred', 'map'] as const) {
      expect(resolveToolLoading(set, 'responder', 'claude-sonnet-5-5')).toBe(set);
      expect(resolveToolLoading(set, 'custom', 'claude-haiku-5-5')).toBe(set);
      expect(resolveToolLoading(set, null, 'm')).toBe(set);
    }
  });

  it('runs an assistant with no setting on the map', () => {
    expect(resolveToolLoading(undefined, 'responder', 'claude-sonnet-5-5')).toBe('map');
    expect(resolveToolLoading(undefined, 'assistant', 'x-ai/grok-4.7')).toBe('map');
  });

  it('runs an assistant on a Haiku model deferred', () => {
    expect(resolveToolLoading(undefined, 'responder', 'claude-haiku-5-5')).toBe('deferred');
    expect(resolveToolLoading(undefined, 'assistant', 'anthropic/Claude-Haiku-5.5')).toBe(
      'deferred',
    );
  });

  it('leaves every other agent with no setting on the full list', () => {
    for (const role of ['custom', 'worker', 'extractor', 'summarizer', 'reflector', null, '']) {
      expect(resolveToolLoading(undefined, role, 'claude-sonnet-5-5')).toBe('full');
    }
  });

  it('treats an unknown stored value as no setting', () => {
    expect(resolveToolLoading('lazy', 'responder', 'claude-sonnet-5-5')).toBe('map');
    expect(resolveToolLoading(null, 'custom', 'claude-sonnet-5-5')).toBe('full');
  });
});
