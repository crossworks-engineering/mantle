/**
 * The one embedding seam @mantle/content has.
 *
 * Recall writes prompt cards and needs vectors for them. Everything else in
 * this package is storage: it reads and writes rows and never calls a model.
 * Reaching for `@mantle/embeddings` from here inverted the layering — content
 * is below the adapter layer, not above it — and it did so through a dynamic
 * `await import()` inside `embedPendingRecallPrompts`, which kept the registry
 * out of module load but left the dependency in package.json all the same.
 *
 * So the direction is flipped: content declares the shape it needs, and the
 * process that owns the adapters injects one at boot. Same idiom as
 * `registerAgentInvoker` (packages/tools/src/agent-bridge.ts).
 *
 * ## Why this bridge throws rather than no-ops
 *
 * `embedPendingRecallPrompts` is called fire-and-forget after a card write, a
 * prompt confirm and from `recall_match`, on paths that must not fail because
 * an embed did. A missing embedder is therefore invisible by construction: the
 * card still saves, and only `recall_match` quietly stops finding prompts —
 * weeks later, with nothing in the logs to connect it to.
 *
 * Returning 0 would be that silent failure. `getRecallEmbedder` throws
 * instead, so the fire-and-forget `.catch` at each caller logs a named error the
 * first time a prompt needs a vector in a process that forgot to register.
 *
 * Registration lives in every process entrypoint that can reach a Recall
 * write, and `recall-embed-registration.test.ts` pins them all:
 *
 *   - server/web/server/main.ts   (the owner Recall routes)
 *   - server/api/src/main.ts      (agent Recall tools, forum + telegram turns)
 *   - server/mcp/src/server.ts    (Recall tools over stdio)
 *   - the server/web workers that dispatch tools (runs, telegram-poll)
 */

/** Embed a batch of texts for one owner. Mirrors `embedBatch` in
 *  @mantle/embeddings; vectors come back in input order. */
export type RecallEmbedder = (ownerId: string, texts: string[]) => Promise<number[][]>;

let registered: RecallEmbedder | null = null;

/**
 * Register the process's embedder. Called once at boot from an entrypoint
 * that owns the adapter layer. Idempotent — last write wins, which is fine for
 * the single-process model.
 */
export function registerRecallEmbedder(fn: RecallEmbedder): void {
  registered = fn;
}

/** True when this process has an embedder. Lets a caller branch instead of
 *  catching — used by the registration test. */
export function hasRecallEmbedder(): boolean {
  return registered !== null;
}

/**
 * The registered embedder. THROWS when the process never registered one:
 * see the header — a silent zero here is invisible for weeks, and the caller's
 * `.catch` turns this throw into a named log line instead.
 */
export function getRecallEmbedder(): RecallEmbedder {
  if (!registered) {
    throw new Error(
      'recall: no embedder registered in this process. Call registerRecallEmbedder(embedBatch) ' +
        'at boot — see packages/content/src/embed-bridge.ts.',
    );
  }
  return registered;
}

/** Test-only: drop the registration so a suite can exercise the unset path. */
export function __resetRecallEmbedderForTests(): void {
  registered = null;
}
