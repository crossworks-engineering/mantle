# Handoff — local embeddings migration (2026-05-30)

Written because context was full mid-migration. **Read the "STATUS RIGHT NOW"
box first** — the brain is mid-transplant and needs two more steps before
retrieval works again.

---

## ⚠️ STATUS RIGHT NOW (the important part)

The brain's embedding space was migrated from cloud `openai/text-embedding-3-small`
(1536-dim) to **local EmbeddingGemma-300m (768-dim)**. The hard, irreversible
part is **done and committed**. Two steps remain:

**DONE (committed + applied to the dev DB):**
- Migration `0060` applied: all six vector columns (`nodes`, `facts`,
  `entities`, `content_chunks`, `tool_result_chunks`, `embedding_cache`) are now
  `vector(768)`; all four retrieval indexes rebuilt as **HNSW**;
  `embedding_cache` truncated.
- Config switched: the `ai_workers kind='embedding'` row → `provider=local`,
  `model=embeddinggemma:latest`, `api_key_id=NULL`. The stale `apostle-paul`
  `memory_config.embedding_model` override was cleared. (0 overrides remain.)
- Code: `EMBEDDING_DIMS` 1536→768; 6 schema column declarations 768. Typecheck
  clean, merged to `main`.
- The `local` provider + `local-embedding` adapter (Phase 1, commit `b6dea96`)
  are live and verified against EmbeddingGemma.
- The embed path now treats `local` as **keyless** (it threw "no api key for
  provider 'local'" otherwise — local servers need no credential). Required for
  both live extraction and the repopulation below.

**NOT DONE (do these next):**
1. **EVERY embedding is currently NULL** (1929 nodes / 5735 facts / 2421
   entities / 6390 chunks). Retrieval returns nothing until repopulated.
2. **The running dev stack is on STALE code** (pre-768, no `local` adapter
   registered, cached `openrouter` embedding config). Until restarted, a live
   responder turn will embed the query at 1536 via OpenRouter and then hit a
   **dimension-mismatch error** comparing against the 768 column. **Restart the
   dev stack now.**

### Environment facts you need
- EmbeddingGemma runs in **Ollama on the Mac**: `http://localhost:11434/v1`,
  model id **`embeddinggemma:latest`**, **768-dim**. Confirmed working
  (`curl localhost:11434/v1/models` and an embed both succeed).
- The adapter's base URL = env **`MANTLE_LOCAL_EMBEDDING_URL`** (default
  `http://localhost:11434/v1` — so no env needed in dev). Keep `ollama serve` up.
- Dev stack runs from `~/Projects/mantle` (main); `apps/web/.env.local` holds
  `DATABASE_URL` + `ALLOWED_USER_ID`. The worktree is
  `.claude/worktrees/brave-nobel-cd3aee` on branch `claude/brave-nobel-cd3aee`,
  fast-forwarded into main after each commit (not pushed).

---

## How to finish: repopulate the 768-dim embeddings

The rows still have their **text** — only the embedding column is null. So this
is a re-embed, not a re-extract. **But `pnpm re-embed` will NOT work as-is** —
two reasons discovered live:

1. `runReembed`'s fetchers filter `WHERE embedding IS NOT NULL` (it was built for
   *same-dimension model swaps* on populated vectors). After the migration nulled
   everything, it finds **0 rows**.
2. The CLI defaults the model to `DEFAULT_EMBEDDING_MODEL` (env), not the worker
   config — so it resolved the *old* `openai/text-embedding-3-small`.

### Recommended path A — fix `runReembed` to repopulate (cheap, embeddings-only)
In `packages/embeddings/src/reembed.ts`, the per-table fetchers use
`isNotNull(<table>.embedding)`. For a dimension-migration repopulation we want
"embed every row that *should* have an embedding," i.e.:
- `facts`, `entities`, `content_chunks`: **all rows** (drop the `isNotNull`
  filter — every row of these tables is always embedded).
- `nodes`: all rows **except** the types the extractor never embeds — exclude
  `type IN ('branch','telegram_message')` and the `conversation-digest` tag
  (these are why `isNotNull` was the implicit filter; replicate it explicitly).
  Node type counts for reference: email 1387, file 271, telegram_message 171,
  branch 30, note 29, page 18, event 12, contact 6, task 3, secret 2.

Add an `includeUnembedded`/repopulate option (don't change the default
same-model behaviour). Then run, pinning the model + the local provider:
```
cd ~/Projects/mantle
MANTLE_LOCAL_EMBEDDING_URL=http://localhost:11434/v1 \
  pnpm -C apps/web re-embed --model=embeddinggemma:latest
```
The provider resolves to `local` from the worker config; `--model` overrides the
env default. ~16K embeds through Ollama — minutes on the M4. (Also widen the
re-embed to cover `content_chunks` if the `--tables` default doesn't — the M1
fix added it; confirm `content_chunks` is in `DEFAULT_TABLES`.)

### Recommended path B — re-extract via the boot-drain (no code change, costs chat LLM)
Restart the dev agent on the new code with a wide drain window:
```
MANTLE_EXTRACT_DRAIN_WINDOW_HOURS=8760 MANTLE_EXTRACT_DRAIN_LIMIT=10000 pnpm dev
```
`drainUnextractedNodes` (boot) re-queues every null-embedding node → the
extractor re-embeds (local) **and** rebuilds facts/entities/chunks. Correct by
construction (uses the pipeline's own embedding decisions), but re-runs
summary+fact extraction = chat-LLM calls (cloud unless you also point the
extractor's chat worker at a local Gemma). Path A is cheaper; B is more "correct"
and also refreshes facts.

**Recommendation:** Path A (fix re-embed) — cheapest, embeddings-only, and the
`isNotNull`→repopulate fix is worth having permanently for future dimension
migrations.

### Verify when done
- `SELECT count(*) FILTER (WHERE embedding IS NOT NULL) FROM nodes;` → non-zero.
- A node's vector length = 768.
- Restart the dev stack; ask the responder something that should hit content/
  facts — confirm it retrieves. The H1 `assertEmbeddingModelConsistency` boot
  check should log **nothing** (all sites agree on the local model).

---

## Everything else from this session (durable, already shipped)

This local-embeddings work sat on top of a large hardening + audit effort —
**all committed to `main`, not pushed.** Canonical records:
- `docs/hardening-audit-2026-05.md` — the independent audit + fixes (chat-runtime
  retry/cache/tool-ids/is_error/image-translation; memory stale-fact retirement,
  chunk re-embed, facts mismatch guard; data-layer HNSW index, prod workers,
  migrate-on-boot; embedding-model consistency check). Read before re-pitching a
  "known issue."
- Memory: `reference_hardening_audit_2026_05`, `project_cost_safety_no_reextract_trigger`
  (never add a model-invoking trigger that can run away — the deletion audit's
  H3 was deliberately NOT built for this reason), `project_delete_cleanup_semantics`
  (the 0058/0059 deletion triggers + kind-aware fact deletion).
- Deletion audit (a separate session's findings, verified + mostly fixed):
  `#1` entity_edges reaper (`0058`), `#2` kind-aware facts (`0059`), `#3`
  page-subtree warning, `#4` file-attachment delete guard — all shipped. Open:
  `#5` object-storage GC (slow leak), `#6` traces linger (by design).

### Open threads worth remembering
- **Chat/extraction local** is the natural next privacy step (embeddings were
  first). Models already pulled on the boxes: `gemma-4-26b-a4b`, `gemma-3-4b`
  (LM Studio on the AMD box `192.168.100.75:1234`). Would need a `local` **chat**
  adapter (the provider exists; add chat capability + register a chat dispatcher
  reusing `openai-compat`). The dual-config/failover idea (local primary + cloud
  fallback per worker) was designed but not built — chat-only; embeddings can't
  fail over (dimension/space lock).
- **jina-embeddings-v5** was evaluated and rejected for the LM Studio path: it
  loads as `type=llm` there (Qwen3 base) and LM Studio silently falls back to
  another embedder. EmbeddingGemma was chosen instead (loads as a real embedder,
  768, Gemma license = commercial-OK). If jina-v5 is ever wanted, serve it via
  llama.cpp `--pooling last` / TEI / vLLM, not LM Studio.
- Minor stale comment: `packages/db/src/schema/ai-workers.ts` still says the
  embedding column is `vector(1536)` "MUST keep at 1536" — now 768. Cosmetic.

## Commit list (this worktree → main, `edd73a8`→ HEAD)
`a394dc3` HNSW index + prod workers · `3a6c7c9` chat retry · `8773e14` cache
breakpoints + Google ids · `99ffa21` is_error/Gemini-images/L1–L4 · `7d78aa7`
memory cluster + migrate-on-boot · `4e20af7` embedding consistency + drain ·
`e3ff2e3` page-subtree delete · (deletion triggers `0058`/`0059` + guards) ·
`b6dea96` local embedding adapter (Phase 1) · `<this>` 768 migration (Phase 2).
Nothing pushed — push when ready.
