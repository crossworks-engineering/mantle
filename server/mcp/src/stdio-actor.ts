/**
 * The stdio MCP server's actor. The process is started
 * for the owner login, so it runs as login(owner): the connect, and every
 * message the transport hands the server (each arrives on stdin's own
 * events, with no actor), never system. Kept apart from server.ts, which
 * runs at module top level, so the binding has a test (stdio-actor.test.ts).
 */
import { loginActor, runAsActor, type Actor } from '@mantle/db';

/** The actor of the stdio server for `ownerId`. */
export function stdioOwnerActor(ownerId: string): Actor {
  return loginActor(ownerId, 'owner');
}

type Transport = { onmessage?: (...args: never[]) => void };

/** Connect `server` to `transport` as `actor`, and run each message the
 *  transport delivers as `actor` too. */
export async function connectStdioAs<T extends Transport>(
  actor: Actor,
  server: { connect(transport: T): Promise<void> },
  transport: T,
): Promise<void> {
  await runAsActor(actor, () => server.connect(transport));
  const onMessage = transport.onmessage;
  if (!onMessage) return;
  transport.onmessage = ((...args: Parameters<NonNullable<T['onmessage']>>) =>
    runAsActor(actor, () => onMessage(...args))) as T['onmessage'];
}
