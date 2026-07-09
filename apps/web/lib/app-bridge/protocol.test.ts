import { describe, expect, it } from 'vitest';
import { isFromApp, isHubNavTarget } from './protocol';

// hub.nav targets arrive from a sandboxed app bundle the shell must not trust:
// the guard decides whether the /team shell navigates. Only the two enumerated
// shapes pass — 'chat' or { briefing: <non-empty string> }. (Which briefings
// actually open is a second gate in the shell: the token must match a real hub
// section.)
describe('isHubNavTarget', () => {
  it("accepts 'chat'", () => {
    expect(isHubNavTarget('chat')).toBe(true);
  });
  it('accepts a briefing with a non-empty token', () => {
    expect(isHubNavTarget({ briefing: 'abc123' })).toBe(true);
  });
  it('rejects malformed targets', () => {
    expect(isHubNavTarget('CHAT')).toBe(false);
    expect(isHubNavTarget('briefing')).toBe(false);
    expect(isHubNavTarget({ briefing: '' })).toBe(false);
    expect(isHubNavTarget({ briefing: 42 })).toBe(false);
    expect(isHubNavTarget({})).toBe(false);
    expect(isHubNavTarget(null)).toBe(false);
    expect(isHubNavTarget(undefined)).toBe(false);
    expect(isHubNavTarget(['chat'])).toBe(false);
  });
});

// The version gate is the only filter between window messages and the bridge
// handlers — the new hub kinds must pass it like every other v1 message.
describe('isFromApp', () => {
  it('accepts v1 hub messages', () => {
    expect(isFromApp({ v: 1, id: 'r1', kind: 'hub.get' })).toBe(true);
    expect(isFromApp({ v: 1, kind: 'hub.nav', target: 'chat' })).toBe(true);
  });
  it('rejects non-v1 / non-object messages', () => {
    expect(isFromApp({ v: 2, kind: 'hub.get' })).toBe(false);
    expect(isFromApp({ kind: 'hub.get' })).toBe(false);
    expect(isFromApp('hub.get')).toBe(false);
    expect(isFromApp(null)).toBe(false);
  });
});
