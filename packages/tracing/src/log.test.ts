import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasLogSink, log, registerLogSink } from './log';

/**
 * Two properties carry the weight here.
 *
 * The first is that the output is byte-identical to the hand-written
 * `console.error('[agent] …')` calls this replaces. The conversion of
 * server/api/src/agent/runtime.ts was mechanical — strip the literal prefix,
 * call log('agent') — and it is only safe if the prefix comes back exactly.
 *
 * The second is that the sink is read per call. Modules build their logger at
 * import time, which in the runner is before DBOS.launch() has run; a logger
 * that captured the sink on construction would freeze every module-level
 * logger onto console and quietly undo the registration, with no symptom
 * except missing workflow context in the logs.
 */
afterEach(() => {
  registerLogSink(null);
  vi.restoreAllMocks();
});

function fakeSink() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('log(scope)', () => {
  it('falls back to console when no sink is registered', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(hasLogSink()).toBe(false);

    log('agent').info('reflector tick every 600s');
    log('agent').error('reflect error:', new Error('boom'));

    expect(logSpy).toHaveBeenCalledWith('[agent] reflector tick every 600s');
    expect(errorSpy).toHaveBeenCalledWith('[agent] reflect error:', expect.any(Error));
  });

  it('reproduces the hand-written prefix exactly', () => {
    const sink = fakeSink();
    registerLogSink(sink);
    log('agent').info('LISTENing on node_ingested');
    // What console.log('[agent] LISTENing on node_ingested') used to emit.
    expect(sink.info).toHaveBeenCalledWith('[agent] LISTENing on node_ingested');
  });

  it('folds the reason INTO an error line for a registered sink', () => {
    // This used to pass the Error through as a second argument, on the theory
    // that the sink would format the stack. DBOS.logger does the opposite: it
    // reads argument two as structured metadata, and the runner's formatter
    // does not print it — so every `log(scope).error('x failed', err)` in the
    // runner reached the container log as a bare "x failed" with no reason at
    // all (2026-09-03 audit). One string, reason included.
    const sink = fakeSink();
    registerLogSink(sink);
    const err = new Error('db down');
    log('agent').error('heartbeat tick error:', err);
    expect(sink.error).toHaveBeenCalledTimes(1);
    const [line, ...extra] = sink.error.mock.calls[0]!;
    expect(extra, 'nothing may ride along as metadata').toEqual([]);
    expect(line).toContain('[agent] heartbeat tick error:');
    expect(line).toContain('db down');
    // The stack too: on an error line it is the whole point of logging.
    expect(line).toContain('log.test.ts');
  });

  it('keeps info/warn lines free of stack noise', () => {
    const sink = fakeSink();
    registerLogSink(sink);
    log('agent').warn('sweep skipped', new Error('busy'));
    const line = sink.warn.mock.calls[0]![0] as string;
    expect(line).toBe('[agent] sweep skipped busy');
  });

  it('still hands the console fallback the raw Error, which prints its own stack', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('db down');
    log('agent').error('heartbeat tick error:', err);
    expect(errorSpy).toHaveBeenCalledWith('[agent] heartbeat tick error:', err);
    expect(errorSpy.mock.calls[0]?.[1]).toBe(err);
  });

  it('reads the sink per call, not when the logger was built', () => {
    // The runner's real ordering: modules build loggers at import, DBOS.launch
    // registers the sink afterwards.
    const logger = log('agent');
    const sink = fakeSink();
    registerLogSink(sink);
    logger.info('after boot');
    expect(sink.info).toHaveBeenCalledWith('[agent] after boot');
  });

  it('folds extra info/warn arguments into the message rather than dropping them', () => {
    const sink = fakeSink();
    registerLogSink(sink);
    log('agent').warn('sweep skipped', { reason: 'busy' });
    expect(sink.warn).toHaveBeenCalledWith('[agent] sweep skipped {"reason":"busy"}');
  });

  it('never lets a throwing sink escape, and reports through console instead', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerLogSink({
      info: () => {
        throw new Error('runtime closed');
      },
      warn: () => {
        throw new Error('runtime closed');
      },
      error: () => {
        throw new Error('runtime closed');
      },
    });

    // A logger that throws can turn an error path into a crash — the reason
    // this bridge falls back where embed-bridge deliberately throws.
    expect(() => log('agent').error('something failed', new Error('x'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[agent] something failed', expect.any(Error));
  });

  it('reports registration state', () => {
    expect(hasLogSink()).toBe(false);
    registerLogSink(fakeSink());
    expect(hasLogSink()).toBe(true);
    registerLogSink(null);
    expect(hasLogSink()).toBe(false);
  });
});
