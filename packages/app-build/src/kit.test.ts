import { describe, expect, it } from 'vitest';
import { KIT } from './kit';

// The @host kit module is a string mirror of apps/web/lib/app-bridge/protocol.ts
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
