/**
 * The stdio MCP server binds its own actor (workspaces arch A2a, M4, L1):
 * the process starts with none, and each message arrives on stdin's own
 * events, so the test drives the connect and a message inside
 * runWithoutActor. Both run as the owner login, login(owner).
 */
import { describe, expect, it } from 'vitest';
import { currentActor, loginActor, runWithoutActor, type Actor } from '@mantle/db';
import { connectStdioAs, stdioOwnerActor } from './stdio-actor';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

describe('the stdio MCP server (arch A2a)', () => {
  it('connects and handles every message as login(owner)', async () => {
    const seen: { at: string; actor: Actor | null }[] = [];
    const transport: { onmessage?: (message: unknown, extra?: unknown) => void } = {};
    const server = {
      async connect(t: typeof transport) {
        seen.push({ at: 'connect', actor: currentActor() });
        t.onmessage = (message, extra) =>
          seen.push({ at: `message ${String(message)} ${String(extra)}`, actor: currentActor() });
      },
    };
    expect(stdioOwnerActor(OWNER)).toEqual(loginActor(OWNER, 'owner'));
    await runWithoutActor(() => connectStdioAs(stdioOwnerActor(OWNER), server, transport));
    runWithoutActor(() => transport.onmessage?.('m1', 'x'));
    const owner = loginActor(OWNER, 'owner');
    expect(seen).toEqual([
      { at: 'connect', actor: owner },
      { at: 'message m1 x', actor: owner },
    ]);
  });
});
