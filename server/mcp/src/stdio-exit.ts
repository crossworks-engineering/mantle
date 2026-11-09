/**
 * The stdio MCP server exits when its client goes. The SDK transport closes
 * itself when stdin ends, but this process also holds database pools, and
 * those keep it alive with nobody to talk to. Under `docker exec -i` that is
 * an orphan of about 260 MB in mantle_web per run: killing the docker exec
 * client ends the server's stdin, and nothing else reaches it (measured on
 * Bun 1.4.4, 2026-11-09).
 *
 * So: the transport's close (stdin end or close), SIGTERM, SIGHUP or SIGINT
 * closes the server and exits, through the one shutdown helper. Kept apart
 * from server.ts, which runs at module top level, so it has a test
 * (stdio-exit.test.ts).
 */
import { onShutdown, type ShutdownProcess } from '@mantle/std/shutdown';

/** stdout carries the JSON-RPC stream, so the shutdown logs go to stderr. */
const stderrLog = {
  info: (message: string) => console.error(message),
  error: (message: string, ...rest: unknown[]) => console.error(message, ...rest),
};

/** Exit when `transport` closes or a stop signal arrives. Call it after
 *  `server.connect(transport)`, which sets the transport's onclose. */
export function exitWithClient(
  server: { close(): Promise<void> },
  transport: { onclose?: () => void },
  proc?: ShutdownProcess,
): void {
  const shutdown = onShutdown({
    name: 'mantle-mcp',
    signals: ['SIGINT', 'SIGTERM', 'SIGHUP'],
    // A close that hangs must not leave the orphan this is here to stop.
    deadlineMs: 3000,
    stop: () => server.close(),
    log: stderrLog,
    process: proc,
  });
  const onClose = transport.onclose;
  transport.onclose = () => {
    onClose?.();
    void shutdown('stdin closed');
  };
}
