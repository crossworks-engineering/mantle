# Handoff — ashley.crossworks.network deploy + four fixes (2026-06-21)

Deployed a fresh Mantle instance to **ashley.crossworks.network** (Contabo
`161.97.98.68`, Ubuntu 24.04, user `cwe`, stack at `/home/cwe/mantle`) via the
published image + `install.sh` with `MANTLE_DOMAIN`. Caddy obtained a production
Let's Encrypt cert; the onboarding/sign-up page serves. Onboarding (the
`ashley@crossworks.engineering` account, a batch of `.xlsx` uploads) surfaced
four real bugs — each fixed, tested, documented, and merged to `main`.

| Symptom (what the operator saw) | Root cause | Fix | Commit |
|---|---|---|---|
| `mantle_updater` crash-looping on a fresh install | `install.sh`'s hand-listed fetch set omitted `infra/updater/updater.sh`; Docker bind-mounted a non-existent path → created an empty **directory** → no entrypoint script. Plus `install.sh` printed "Mantle is up" without noticing. | Fetch `updater.sh`; add a domain/port pre-flight + a post-`up` "any restarting/unhealthy container" check; give `web` a `/api/health` healthcheck so `--wait` and Caddy's `depends_on` actually gate. Also dropped the author-specific `push.crossworks.network` block from the shipped Caddyfile (was failing ACME on every other install). | `a88dbf3` (+ merge `96ecb49`) |
| Dashboard "embedder not running" while embedding worked fine | The health probe ran its own `embedding_config` SELECT and returned `not configured` when no row existed (every fresh install); the **resolver** falls back to the bundled local default, so the two disagreed. | Route `embedderHealth` through `resolveEmbeddingConfig` — the same single source of truth ingest uses — so a fresh install probes the local default and reports truthfully. | `1fe3340` (+ merge `2583624`) |
| A web `/assistant` turn died with a context-free `Unexpected end of JSON input` after a 34 s stall (16 steps: search + 10 file_reads, then the 3rd model call) | An upstream timeout returned an empty 2xx body; `@openrouter/sdk`'s `JSON.parse('')` threw a bare `SyntaxError`. The SDK retries HTTP transients but not a thrown parse error, the OpenRouter adapter isn't wrapped by `withChatRetry`, and the adapter only enriched `OpenRouterError` — so nothing retried and the message had no context. | `isEmptyJsonBodyError` (end-of-input family only) added to `classifyChatError`; `openrouter-chat.ts` retries that case itself (full-jitter backoff, honours `opts.maxRetries`) and wraps an exhausted failure as `OpenRouterEmptyResponseError` naming the model + elapsed. | `09a73ed` `140778a` (+ merge `fcec392`) |
| Three `.xlsx` uploads "failed" — extractor trace `status=error`, `step_count=0`, 0 tokens, `duration ≈ 603 s`, "abandoned — no completion after 10 min" | **Zero steps** = the stall was in the synchronous xlsx→text parse, *before* the first `llm_extract` step (not tokens, not out-of-turns; the process never restarted). xlsx files declare an inflated used-range (out to row 1,048,576 / col XFD); SheetJS's `sheet_to_csv` walks the whole range — millions of phantom cells block the single extractor and head-of-line-block the queue (the perpetual "re-queueing 57-61 nodes" sweep). | `parseXlsx` bounds the flatten: `sheetRows` caps rows at read time (5,000), the column span is clamped (256) via `!ref` rewrite, total output capped (256 KB), with a truncation marker. Lossless for recall in practice. | `cb3025a` (+ merge `7fefc30`) |

## Diagnostic notes worth keeping

- **`step_count=0` + "abandoned after 10 min"** is the signature of a stall in a
  pre-first-`step()` code path (a parser, a byte read) — *not* a crash and *not*
  an LLM/turn problem. The watchdog's "process likely restarted" text is a guess;
  confirm with `docker inspect <ctr> --format '{{.RestartCount}} {{.State.OOMKilled}}'`.
- **`docker compose up -d --wait` is not a health gate** for services without a
  healthcheck — a crash-looping sidecar sails right past it. The installer now
  greps `docker compose ps` for `restarting|unhealthy` after `up`.
- Two upstream installer gaps share a class: `install.sh` hand-lists files while
  `release.yml` bundles all of `infra/` (`cp -R`). They drift. A durable follow-up
  is to have `install.sh` extract the release/ref tarball instead.

## Still open (not blocking)

- The four fixes ship to a running box only on the next `titanwest/mantle` image
  release. The ~16 backlogged `.xlsx` on ashley drain automatically (the extract
  sweep re-queues them) once that image is pulled.
- On the box itself, the embedder tile goes green the moment the embedder is saved
  in Settings → Embedding; embedding already works regardless.
