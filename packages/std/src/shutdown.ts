/**
 * The one shutdown helper (A10 #15). Three processes wired SIGINT and
 * SIGTERM by hand, each a little differently: the workers' runner had a
 * guard and a 15 s exit deadline, the web server a 5 s one and no guard,
 * and the API process neither guard nor deadline, so a teardown that hung
 * (a pg-boss drain, DBOS) held the process forever where nothing sends a
 * SIGKILL (a dev shell, a systemd unit without a stop timeout). Under
 * Docker the SIGKILL comes after the container's stop_grace_period, so each
 * service names one past its process's deadline (docker-compose.yml).
 *
 * onShutdown installs both handlers. The first signal logs, arms the exit
 * deadline, runs `stop`, and exits with `exitCode`; a stop that throws is
 * logged and the process still exits; a stop that outlives the deadline is
 * cut by it (with `deadlineExitCode`, 1 unless named: a teardown that ran
 * out of time has failed). A second signal while stopping is ignored, so it
 * cannot race the first.
 *
 * Node only (process signals): its own entry, '@mantle/std/shutdown', so the
 * package index stays free of node APIs.
 */
export type ShutdownLog = {
  info(message: string): void;
  error(message: string, ...rest: unknown[]): void;
};

/** What onShutdown needs of the process (a test passes its own). */
export type ShutdownProcess = {
  on(signal: string, listener: () => void): unknown;
  exit(code: number): never | void;
};

export type ShutdownOptions = {
  /** The log prefix: `[name] SIGTERM — shutting down`. */
  name: string;
  /** Tear down what the process owns. */
  stop: (signal: string) => Promise<void> | void;
  /** The most the teardown may take, in ms. */
  deadlineMs: number;
  /** The exit code when the deadline cuts the teardown (default 1). */
  deadlineExitCode?: number;
  /** The exit code once the teardown is done (default 0). */
  exitCode?: number;
  log?: ShutdownLog;
  signals?: readonly string[];
  process?: ShutdownProcess;
};

const consoleLog: ShutdownLog = {
  info: (m) => console.log(m),
  error: (m, ...rest) => console.error(m, ...rest),
};

/**
 * Install the shutdown handlers. Returns the shutdown itself (what a
 * signal runs), for a test or a process that stops for a reason of its own.
 */
export function onShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const proc = opts.process ?? (process as ShutdownProcess);
  const log = opts.log ?? consoleLog;
  const deadlineCode = opts.deadlineExitCode ?? 1;
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`[${opts.name}] ${signal} — shutting down`);
    const deadline = setTimeout(() => {
      log.error(`[${opts.name}] shutdown exceeded ${opts.deadlineMs}ms — exiting anyway`);
      proc.exit(deadlineCode);
    }, opts.deadlineMs);
    try {
      await opts.stop(signal);
    } catch (err) {
      log.error(`[${opts.name}] shutdown failed:`, err);
    }
    clearTimeout(deadline);
    proc.exit(opts.exitCode ?? 0);
  };
  for (const signal of opts.signals ?? ['SIGINT', 'SIGTERM']) {
    proc.on(signal, () => void shutdown(signal));
  }
  return shutdown;
}
