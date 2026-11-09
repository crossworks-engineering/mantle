/**
 * The stdio MCP server exits when its client goes. The SDK transport closes
 * itself when stdin ends, but this process also holds database pools, and
 * those keep it alive with nobody to talk to. Under `docker exec -i` that is
 * an orphan of about 280 MB in mantle_web per run: killing the docker exec
 * client ends the server's stdin, and nothing else reaches it (measured on
 * Bun 1.4.4, 2026-11-09).
 *
 * So: the transport's close (stdin end or close, a stdout error), SIGTERM,
 * SIGHUP or SIGINT closes the server and exits, through the one shutdown
 * helper. Before the exit, the last reply is flushed and the audit rows of
 * the last calls are written. Kept apart from server.ts, which runs at module
 * top level, so it has a test (stdio-exit.test.ts).
 */
import { format } from 'node:util';
import { callAuditsSettled } from '@mantle/db';
import { onShutdown, type ShutdownProcess } from '@mantle/std/shutdown';

/** stdout carries the JSON-RPC stream, so the shutdown logs go to stderr
 *  (log(scope) would send info to stdout). */
const stderrLog = {
  info: (message: string) => void process.stderr.write(`${message}\n`),
  error: (message: string, ...rest: unknown[]) =>
    void process.stderr.write(`${format(message, ...rest)}\n`),
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
    stop: async () => {
      await server.close();
      await callAuditsSettled();
      // A reply still in the pipe's buffer is cut by an exit.
      await new Promise<void>((done) => process.stdout.write('', () => done()));
    },
    log: stderrLog,
    process: proc,
  });
  const onClose = transport.onclose;
  transport.onclose = () => {
    try {
      onClose?.();
    } finally {
      void shutdown('client gone');
    }
  };
}
