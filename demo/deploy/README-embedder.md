# The demo's embedder — read before deploying

The serve-time stack runs **no Ollama**. Search still embeds the query on every
keystroke-completed search, so the demo embeds through an **online** route named
in the brain itself. This note is the bridge between "the brain as seeded" and
"the brain as served", because those are not currently the same thing.

## The state of the brain today (measured, not assumed)

```
embedding_config          0 rows
api_keys                  1 row  — openrouter, last used 2026-07-31
vectors already stored    791 content_chunks · 846 nodes · 871 facts · 332 entities
column shape              vector(768), hard-locked in the schema
```

Zero rows in `embedding_config` is the whole problem in one line. With no row,
`resolveEmbeddingConfig()` returns `LOCAL_FALLBACK_CONFIG` — provider `local`,
model `embeddinggemma:latest`, reached at `MANTLE_LOCAL_EMBEDDING_URL`. That is
what built all 2,840 vectors above, and with Ollama gone it is also what the
serve box would try to call and fail to reach.

So switching the demo to an online embedder is **two changes, not one**:

1. give the brain an `embedding_config` row naming the online model, and
2. **re-embed every stored vector with that model**, on the workstation, before
   the dump is taken.

Do only the first and nothing errors — the query lands in one model's vector
space and the passages sit in another's, cosine similarity across the two is
meaningless, and search returns confident nonsense. Silent, plausible, wrong:
the same shape as the file-bytes bug that hid for a week.

## Which model

The column is `vector(768)` everywhere and cannot move without a migration, so
the online model must land on 768 dims. `text-embedding-3-small` / `-large` are
MRL-trained, and the OpenRouter adapter truncates + renormalises them to 768
client-side (mathematically identical to the provider's own `dimensions` param).

**Use OpenRouter.** The brain's vault already holds an OpenRouter key and
nothing else, so this needs no new credential anywhere:

```
provider    openrouter
model       openai/text-embedding-3-large
dimensions  768
key         the existing vault row
```

`openai` direct is the app's shipped default (`DEFAULT_ONLINE_EMBEDDING_MODEL`),
and works identically — but it means putting a second key in the vault for no
gain.

## Doing it

On the **workstation**, against the seed stack with the **owner** role — a
re-embed is a write, and `demo_reader` cannot do it:

1. Set the config row at `/settings/ai-workers/embedding` (owner UI, seed
   stack), or write the row directly. Confirm it took:
   ```bash
   docker exec mantle_demo_pg psql -U postgres -d postgres -x -c "select model, dimensions, primary_provider from embedding_config"
   ```
2. Re-embed all four tables:
   ```bash
   pnpm -C server/web re-embed --dry-run
   ```
   then drop `--dry-run`. It walks `nodes`, `facts`, `entities` and
   `content_chunks` — exactly the four that carry vectors. `tool_result_chunks`
   is deliberately excluded: it is a transient spill store that self-heals on a
   model swap.
3. Spot-check a search whose answer lives only inside a PDF ("issued for
   tender" is the one that proved the file-bytes fix) and confirm the
   transmittals still come back.
4. **Then** take the dump. A dump taken before the re-embed carries the old
   vectors and looks perfectly healthy.

Cost is small — ~2,840 vectors of already-extracted text, cents at
text-embedding-3-large's rate — but it is not free and it is not resumable
mid-table, so run it once, deliberately.

## Two things to decide, not to discover

**The key ships with the brain.** `api_keys.key_enc` is in the dump, encrypted
under `MANTLE_MASTER_KEY` — and that key must be on the box for the vault to
open at all. So the demo box holds a working OpenRouter credential no matter
what the handover says about keeping chat keys off public-facing hosts. It is
reachable only by code the read-only edge lets run, but it is there.

**Every visitor's search is a billed API call.** A local embedder made search
free; an online one puts a spend path behind an anonymous, unauthenticated,
publicly-linked text box. Before this is linked from the site header, decide
what bounds it — `MANTLE_RATE_LIMIT_SCALE` on the serve stack, a spend cap on
the OpenRouter key, or a dedicated key for the demo that can be revoked without
touching anything else. A dedicated, capped key is the cheapest of the three and
also answers the paragraph above.
