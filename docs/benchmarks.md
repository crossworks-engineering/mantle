# Memory benchmarks (LoCoMo, LongMemEval)

`pnpm -C server/api bench:memory` scores the brain on the two public long-term
memory benchmarks, end to end, through the shipped code: ingest, extraction,
retrieval, an answer and a judge. [recall-eval.md](recall-eval.md) measures
retrieval on your own gold set; this measures whole answers on public data,
so the number sits next to other memory systems'.

Code: [`server/api/src/bench/`](../server/api/src/bench/).

## What a run does

Each haystack (a LoCoMo conversation; a LongMemEval question's history) gets
its own scratch database, cloned from one migrated template, so every
haystack is a fresh brain. In a child process per haystack:

1. **Seed.** A brain owner, the OpenRouter key, an `extractor` worker, the
   embedding config and a responder agent with the default memory settings.
   No decider worker, so retrieval is deterministic.
2. **Ingest.** Each session becomes a note titled and headed with its date
   (the extractor reads only title and body, and resolves "yesterday" against
   a date it can see). `created_at` is set to the session date. Then
   `extractNode` runs on each note: the same code the extract queue runs.
3. **Answer.** `loadConversationContext` retrieves for the question. The
   memory blocks are rendered by `buildChatMessages`, exactly as the
   responder would see them (facts, items, relations, passages, digests, the
   corpus map). One call to the answer model, with our answer prompt
   ([`prompts.ts`](../server/api/src/bench/prompts.ts)) and the question date.
4. **Judge.** The published judges: Mem0's LoCoMo judge (Apache-2.0) and
   LongMemEval's official per-type checks (MIT). The judge grades the final
   "Answer:" line.

Accuracy counts every attempted question. An error or an unreadable verdict
counts as wrong.

## Running it

Run it on the workstation against a throwaway Postgres, never a brain's. It
creates and drops only databases named `mantle_bench_*` and `mantle_scratch_*`,
but it needs a superuser to do that.

```bash
docker run -d --name bench-pg -e POSTGRES_PASSWORD=pw -p 55441:5432 \
  -v "$PWD/infra/postgres/init:/docker-entrypoint-initdb.d:ro" pgvector/pgvector:pg18
cd server/api
BENCH_PG_ADMIN_URL=postgres://postgres:pw@localhost:55441/postgres \
BENCH_OPENROUTER_API_KEY="$(cat ~/.config/mantle-bench/openrouter.key)" \
pnpm bench:memory --dataset=locomo --download --haystacks=1 --questions=20 --max-usd=2
```

| Flag                                | Meaning                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `--dataset=locomo\|longmemeval`     | Required.                                                            |
| `--download`                        | Fetch the data file to `~/.cache/mantle-bench/data/` when missing.   |
| `--dry-run`                         | Print the plan and a cost estimate; no database, no model call.      |
| `--haystacks=N` `--questions=N`     | The first N haystacks; the first N questions of each.                |
| `--per-category=N`                  | Up to N questions of each category, in file order (LongMemEval).     |
| `--only=id,id`                      | Only these haystacks.                                                |
| `--max-usd=N`                       | Hard spend cap (default 1). Checked during ingest and per question. |
| `--answer-model` `--judge-model`    | Default: AMB's published pair (Gemini 3.1 Pro, Gemini 2.5 Flash Lite). |
| `--extractor-model` `--embedding-model` | Default: the brain's shipped defaults.                          |
| `--concurrency=N` `--extract-concurrency=N` | Haystacks in parallel (2); notes extracted in parallel (4). |
| `--out=DIR` / `--resume=DIR`        | Where results go; resume skips haystacks already written there.     |
| `--keep-db`                         | Keep the scratch databases for inspection.                          |

Output: `results.jsonl` (one line per question, with the model's full
response and the judge's text), `summary.json` and `report.md`.

**Manual runs only.** Every run spends real money; nothing schedules it
(cost-safety rule). Estimates at the default models: a full LoCoMo run is
about \$49, nearly all of it the answer model (about \$10 with a Flash Lite
answer model); one conversation with 20 questions is under \$1.

## Reading a number

The AMB leaderboard ([vectorize-io/agent-memory-benchmark](https://github.com/vectorize-io/agent-memory-benchmark))
publishes runs with the same answer and judge models: LoCoMo, Hindsight 92.0%
at about 36k context tokens per question and a hybrid-search baseline 79.1%;
LongMemEval-S, Hindsight 94.6% and the baseline 74.0%. Their answer prompt
differs from ours, and a sample run is not a full run. The report prints
those references and our context size beside our score: our per-turn memory
context is bounded (about 22k characters, near 6k tokens), a far smaller
budget than theirs.

Known limits:

- The extractor reads at most 8,000 characters of a note's body. No LoCoMo
  session is that long (the longest is about 7,500); many LongMemEval
  sessions are, so their tails reach retrieval only as passages.
- Recency ranking decays against the real clock, not the question date. All
  benchmark sessions are years old, so the decay is nearly flat across them.
- A single call answers each question (AMB's "rag" mode). The responder's
  own tools (search, read a note) are not used.
