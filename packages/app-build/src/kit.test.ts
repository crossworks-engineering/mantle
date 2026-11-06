import { describe, expect, it } from 'vitest';
import { KIT } from './kit';

// The @host kit module is a string mirror of packages/share-ui/src/app-bridge-protocol.ts
// (the sandbox can't import host code, so the shapes are duplicated by design).
// These are drift tripwires: if a bridge kind is renamed or dropped on either
// side, the app-facing API silently stops matching what the host answers.
describe('@host kit ↔ bridge protocol mirror', () => {
  const HOST = KIT['@host']!;

  it('exposes the core bridge kinds', () => {
    for (const kind of ['tool.call', 'db.query', 'db.exec', 'db.batch']) {
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

  it('a rejected call carries the broker reason, so an app can read err.reason', () => {
    expect(HOST).toContain('{ reason: m.reason }');
  });

  it('host.db.batch posts its statements and its guard, and no word of its own', () => {
    expect(HOST).toContain("kind: 'db.batch', statements, guard: opts?.guard");
  });

  it('host.db.batch refuses a misspelt guard, and posts nothing', async () => {
    const start = HOST.indexOf('batch: (statements, opts) => {');
    const end = HOST.indexOf('\n    },\n', start);
    const source = HOST.slice(start + 'batch: '.length, end) + '}';
    const posted: unknown[] = [];
    const batch = new Function('post', `return ${source};`)((m: unknown) => {
      posted.push(m);
      return Promise.resolve('sent');
    }) as (s: unknown[], o?: unknown) => Promise<unknown>;
    await expect(batch([], { gaurd: {} })).rejects.toThrow(/gaurd/);
    await expect(batch([], { sql: 'SELECT 1', params: [] })).rejects.toThrow(/params/);
    // The key is right, its value is not: state.gaurd was undefined.
    await expect(batch([], { guard: undefined })).rejects.toThrow(/nothing else/);
    await expect(batch([], true)).rejects.toThrow(/nothing else/);
    expect(posted).toEqual([]);
    await expect(batch([])).resolves.toBe('sent');
    await expect(batch([], { guard: { sql: 'SELECT 1' } })).resolves.toBe('sent');
    expect(posted).toHaveLength(2);
  });

  it('Loading is small, labelled for a screen reader, theme-only and still under reduced motion', () => {
    const LOADING = KIT['@/components/ui/loading']!;
    expect(LOADING).toContain('export function Loading(');
    expect(LOADING).toContain('role="status"');
    expect(LOADING).toContain('sr-only');
    expect(LOADING).toContain('aria-hidden="true"');
    expect(LOADING).toContain('prefers-reduced-motion:reduce');
    expect(LOADING).toContain('bg-primary');
    expect(LOADING).toContain('text-muted-foreground');
    // Never a full-screen state, never a hard-coded colour, no import but the kit's.
    expect(LOADING).not.toMatch(/fixed|absolute|inset-0|min-h-screen|h-screen|#[0-9a-f]{3,6}/i);
    expect([...LOADING.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual([
      'react',
      '@/lib/utils',
    ]);
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
