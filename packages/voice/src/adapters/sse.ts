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
 */

import type { ChatStreamDelta, ChatStreamSink } from './types';

/** Yield each SSE `data:` payload from a fetch body (sans the `data:` prefix).
 *  Comment/`event:`/`id:`/blank lines are skipped. Stops on `signal` abort. */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
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
    // Stop the underlying network stream when we break out (DONE / abort / error).
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** Combine a request's cancellation signal (`opts.signal`, for a user Stop) with
 *  a per-call timeout, so a chat fetch aborts on whichever fires first. Use for
 *  the one-shot `chat()` path; the streaming path passes `opts.signal` raw (its
 *  own loop is the time bound). */
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
