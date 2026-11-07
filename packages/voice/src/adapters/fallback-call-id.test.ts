import { describe, expect, it } from 'vitest';
import { fallbackToolCallId } from './fallback-call-id';

describe('fallbackToolCallId', () => {
  it('never repeats, for the same tool or another, keeping the call_<name> start', () => {
    const ids = Array.from({ length: 50 }, (_, i) => fallbackToolCallId(i % 2 ? 'ui_click' : 'x'));
    expect(new Set(ids).size).toBe(50);
    expect(ids[1]).toMatch(/^call_ui_click_\d+$/);
    // The provider's tool_use id pattern (letters, digits, _ and -).
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
