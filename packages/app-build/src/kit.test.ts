import { describe, expect, it } from 'vitest';
import { KIT } from './kit';

// The @host kit module is a string mirror of packages/web-ui/src/app-bridge/protocol.ts (formerly server/web/lib/app-bridge)
// (the sandbox can't import host code, so the shapes are duplicated by design).
// These are drift tripwires: if a bridge kind is renamed or dropped on either
// side, the app-facing API silently stops matching what the host answers.
describe('@host kit ↔ bridge protocol mirror', () => {
  const HOST = KIT['@host']!;

  it('exposes the core bridge kinds', () => {
    for (const kind of ['tool.call', 'db.query', 'db.exec']) {
      expect(HOST).toContain(`kind: '${kind}'`);
    }
  });

  it('exposes host.me(), read from the frame-baked viewer (app identity)', () => {
    expect(HOST).toContain('window.__mantleHostMe');
    expect(HOST).toMatch(/export const host = \{\n {2}me,/);
    // No email anywhere in the answer.
    expect(HOST).not.toMatch(/email:/);
  });

  it('host.me() answers the baked viewer, and rejects where none was baked', async () => {
    const src = HOST.slice(HOST.indexOf('function me() {'));
    const body = src.slice(0, src.indexOf('\n}\n') + 2);
    const make = (win: Record<string, unknown>) =>
      new Function('window', `${body}; return me;`)(win) as () => Promise<unknown>;
    await expect(
      make({ __mantleHostMe: { id: 'u_a', name: 'Pat', kind: 'member', email: 'x' } })(),
    ).resolves.toEqual({ id: 'u_a', name: 'Pat', kind: 'member' });
    await expect(make({ __mantleHostMe: { kind: 'public' } })()).resolves.toEqual({
      id: null,
      name: null,
      kind: 'public',
    });
    await expect(make({})()).rejects.toThrow(/not available/);
  });

  it('exposes the team-hub namespace with the enumerated hub kinds', () => {
    expect(HOST).toContain("kind: 'hub.get'");
    // All nav intents post the SAME event kind with the target shapes the
    // shell's isHubNavTarget guard accepts (chat / briefing / app).
    expect(HOST).toContain("kind: 'hub.nav', target: 'chat'");
    expect(HOST).toContain("kind: 'hub.nav', target: { briefing: String(token) }");
    expect(HOST).toContain("kind: 'hub.nav', target: { app: String(token) }");
    for (const api of ['hub:', 'get:', 'openChat:', 'openBriefing:', 'openApp:']) {
      expect(HOST).toContain(api);
    }
  });
});
