/**
 * Shared server-sent-events plumbing for streaming chat adapters.
 *
 * All three streaming wire formats we parse frame their payloads as `data: …`
 * lines: OpenAI-compat (`data: {json}` … `data: [DONE]`), Anthropic (`event:
 * <type>\ndata: {json}` — the json also carries `type`, so we ignore the event
 * line), and Gemini `:streamGenerateContent?alt=sse` (`data: {json}`). This
 * reader yields each `data:` payload string; the caller JSON-parses and
 * interprets it per provider.
 *
 * Abort-aware: it checks `signal.aborted` between reads and cancels the
 * underlying reader when iteration stops, so a user Stop closes the connection
 * promptly (upstream generation halts) and the caller can return the partial.
 *
 * Time-bounded (2026-09-02 audit): the one-shot `chat()` path always had a 60s
 * fetch timeout, but the streaming path passed the caller's signal raw, so a
 * provider that accepted the request and then went quiet hung the turn until
 * the user pressed Stop. Two bounds now apply to every stream:
 *
 *   - CONNECT: headers must arrive within {@link STREAM_CONNECT_TIMEOUT_MS}
 *     ({@link streamAbort}). The same 60s the one-shot path uses. A miss is a
 *     `TimeoutError` BEFORE any delta reached the user, so the retry wrapper
 *     treats it like any other transient failure and re-sends.
 *   - IDLE: once streaming, {@link STREAM_IDLE_TIMEOUT_MS} between chunks
 *     ({@link readSSE} `idleMs`, {@link withIdleTimeout} for SDK iterables).
 *     Any bytes count — provider keep-alives (Anthropic `ping` events,
 *     OpenRouter `: PROCESSING` comments) reset it, so a long think is fine;
 *     a dead socket is not. A miss throws `TimeoutError` mid-stream; the
 *     retry wrapper does NOT replay a stream that already emitted deltas, so
 *     the turn fails loudly instead of hanging forever.
 */

import type { ChatStreamDelta, ChatStreamSink } from './types';

/** Headers must arrive within this long, or the request is abandoned. */
export const STREAM_CONNECT_TIMEOUT_MS = 60_000;
/** Longest silence tolerated between two chunks of an open stream. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

function timeoutError(what: string, ms: number): Error {
  // `name === 'TimeoutError'` is what classifyChatError keys on, matching the
  // DOMException `AbortSignal.timeout()` raises on the one-shot path.
  return new DOMException(`chat stream ${what} after ${ms}ms of silence`, 'TimeoutError');
}

/**
 * Abort wiring for one streaming request. Returns the signal to hand to fetch
 * (or an SDK), which fires on the caller's Stop OR a connect timeout, whichever
 * comes first. Call `connected()` as soon as the response headers are in so the
 * connect timer stops governing the body read (a stream may legitimately run
 * for minutes); `abortIdle()` tears the connection down when the idle guard
 * trips, so the socket does not linger after the caller gave up on it.
 */
export function streamAbort(
  signal: AbortSignal | undefined,
  connectMs: number = STREAM_CONNECT_TIMEOUT_MS,
): { signal: AbortSignal; connected: () => void; abortIdle: () => void } {
  const ctrl = new AbortController();
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  const timer = setTimeout(
    () => ctrl.abort(timeoutError('connect timed out', connectMs)),
    connectMs,
  );
  return {
    signal: ctrl.signal,
    connected: () => clearTimeout(timer),
    abortIdle: () => {
      clearTimeout(timer);
      ctrl.abort(timeoutError('idle', STREAM_IDLE_TIMEOUT_MS));
    },
  };
}

/** Race a pending read against the idle clock. Resolves with the read; throws
 *  `TimeoutError` when nothing arrives within `idleMs`. */
async function readWithIdle<T>(pending: Promise<T>, idleMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError('idle', idleMs)), idleMs);
  });
  try {
    return await Promise.race([pending, idle]);
  } finally {
    clearTimeout(timer);
  }
}

/** Yield each SSE `data:` payload from a fetch body (sans the `data:` prefix).
 *  Comment/`event:`/`id:`/blank lines are skipped. Stops on `signal` abort.
 *  With `idleMs`, a gap between chunks longer than that throws `TimeoutError`
 *  (any bytes reset the clock, keep-alive comments included). */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: { idleMs?: number } = {},
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleMs = options.idleMs;
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = idleMs
        ? await readWithIdle(reader.read(), idleMs)
        : await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        // Each provider keeps one JSON object per `data:` line, so we don't need
        // to coalesce multi-line data fields — just emit each payload.
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).replace(/^ /, '');
        if (payload) yield payload;
      }
    }
  } finally {
    // Stop the underlying network stream when we break out (DONE / abort /
    // error / idle). On idle this is also what settles the orphaned read.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** The idle guard for an SDK-provided async iterable (OpenRouter's stream):
 *  yields its items, throws `TimeoutError` when the next one takes longer than
 *  `idleMs`, and calls `onIdle` first so the caller can tear the socket down. */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onIdle?: () => void,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let next: IteratorResult<T>;
      try {
        next = await readWithIdle(it.next(), idleMs);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'TimeoutError') onIdle?.();
        throw err;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    try {
      await it.return?.();
    } catch {
      /* already closed */
    }
  }
}

/** Combine a request's cancellation signal (`opts.signal`, for a user Stop) with
 *  a per-call timeout, so a chat fetch aborts on whichever fires first. Use for
 *  the one-shot `chat()` path; the streaming path uses {@link streamAbort}, whose
 *  timer stops at the headers so it cannot cut a long, healthy stream. */
export function chatAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Call a delta sink without ever letting a throwing consumer break the stream
 *  loop — a sink fault is the caller's bug, not a connection fault. */
export function safeDelta(onDelta: ChatStreamSink, delta: ChatStreamDelta): void {
  try {
    onDelta(delta);
  } catch (err) {
    console.warn(
      '[chat-stream] delta sink threw (ignored):',
      err instanceof Error ? err.message : err,
    );
  }
}

/** The base URL a fetch adapter should hit: the route's own `baseUrl` when the
 *  operator set one (trailing slashes dropped), else the provider default.
 *  Before 2026-09-02 only the custom/local adapters read `opts.baseUrl`; a
 *  per-route override on an Anthropic or Google route was silently ignored. */
export function routeBase(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : fallback;
}
