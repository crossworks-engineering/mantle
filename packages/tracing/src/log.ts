/**
 * A scoped logger, and the one seam that lets the runner's logs reach DBOS.
 *
 * The repo had two logging worlds that never met. Workflow code called
 * `DBOS.logger`, which stamps the workflow id and step onto every line and is
 * what you actually read when a durable turn goes wrong. Everything else
 * called `console.*` with a hand-written `[scope]` prefix — 39 of them in
 * server/api's runtime.ts alone — which lands in the container log with no
 * workflow context at all. Which one a given line used came down to whether
 * its file happened to import DBOS.
 *
 * `log(scope)` is the single entry point. It prefixes `[scope]` exactly as the
 * hand-written calls did, and it routes through a sink the process registers
 * at boot. server/api registers `DBOS.logger`, so the runner's lines gain
 * workflow context for free; anything with no sink registered falls back to
 * console, which is what a script, a test or the web tier wants.
 *
 * ## Why a sink rather than importing DBOS
 *
 * @mantle/tracing is imported by the web tier, the workers, the packages and
 * the test suite. Depending on @dbos-inc/dbos-sdk here would pull a workflow
 * engine into all of them to format a string. Same idiom as
 * `registerAgentInvoker` (packages/tools/src/agent-bridge.ts) and
 * `registerRecallEmbedder` (packages/content/src/embed-bridge.ts): the
 * low-level package declares the shape, the process that owns the
 * implementation injects it.
 *
 * ## Why it does not throw when unregistered
 *
 * The opposite call to the one `embed-bridge.ts` makes, and for the opposite
 * reason. A missing embedder is invisible until Recall quietly stops working,
 * so that bridge throws. A missing log sink is not a failure at all: console
 * is a correct destination, and a logger that throws is a logger that can turn
 * an error path into a crash. Falling back is the whole point.
 */

/** What a sink must provide. `DBOS.logger` satisfies this as-is. */
export type LogSink = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, ...rest: unknown[]): void;
};

/** A scoped logger. `rest` is passed through untouched, so an Error argument
 *  keeps its stack rather than being flattened into the message. */
export type ScopedLogger = {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
};

const consoleSink: LogSink = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, ...rest) => console.error(m, ...rest),
};

let sink: LogSink | null = null;

/**
 * Register the process's sink. Called once at boot; server/api passes
 * `DBOS.logger`. Pass null to go back to console (used by tests).
 */
export function registerLogSink(next: LogSink | null): void {
  sink = next;
}

/** True when a sink is registered. For tests and boot assertions. */
export function hasLogSink(): boolean {
  return sink !== null;
}

/**
 * A logger that prefixes every line with `[scope]`.
 *
 * The sink is read PER CALL, not captured when the logger is built: modules
 * create their logger at import time, which for the runner is before
 * `DBOS.launch()` has run. Capturing here would freeze every module-level
 * logger onto console and silently undo the registration.
 */
export function log(scope: string): ScopedLogger {
  const prefix = `[${scope}]`;
  return {
    info: (message, ...rest) => emit('info', `${prefix} ${message}`, rest),
    warn: (message, ...rest) => emit('warn', `${prefix} ${message}`, rest),
    error: (message, ...rest) => emit('error', `${prefix} ${message}`, rest),
  };
}

function emit(level: 'info' | 'warn' | 'error', message: string, rest: unknown[]): void {
  const target = sink ?? consoleSink;
  try {
    if (level === 'error') {
      target.error(message, ...rest);
      return;
    }
    // info/warn take a message only, which is DBOS.logger's shape. Anything
    // extra is appended to the message so it is not silently dropped.
    target[level](rest.length > 0 ? `${message} ${rest.map(render).join(' ')}` : message);
  } catch {
    // A logger must never be the reason a request fails. If a registered sink
    // throws (a closed DBOS runtime during shutdown, say), fall back rather
    // than propagate — and never recurse into the sink to report it.
    if (target !== consoleSink) consoleSink.error(message, ...rest);
  }
}

/** Best-effort rendering for extra args folded into an info/warn message. */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
