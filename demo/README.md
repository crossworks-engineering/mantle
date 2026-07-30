# demo/ — the public demo of Mantle

Everything for the public, read-only demo: a **real** Mantle brain filled with
**generated, fictional** content, served by the **real** API and the **real**
UI — no fixture server, no per-screen demo code.

## The rules (breaking these is how v1 died)

1. **This tree is purely additive.** Nothing outside `demo/` may be touched on
   this branch. `git diff main --name-only` must list only `demo/**` — that
   property is what makes `git merge main` conflict-free forever.
2. **One-way street.** `main` merges into `demo`; `demo` never merges into
   `main`.
3. **Generated content only.** No bytes from any real brain, ever. Embeddings
   cannot be scrubbed (the vector still encodes the original text) and traces
   hold full prompts verbatim — so scrubbing real data is not a lesser option,
   it is off the table. A real brain may contribute *statistics* (nodes per
   type, body-length distributions, edge density) — numbers, never bytes.
4. **Fictional world, documentation domains.** Every person, company and
   address comes from the world bible (P1); every email is on an RFC 2606
   domain (`example.com/.org/.net`). The publish guard enforces this by shape,
   and runs **post-ingest** too — LLM-written summaries can hallucinate
   real-sounding names that were never in the source.
5. **Never stop a running Mantle stack to run this one.** The seed/test stack
   is designed to run *alongside* a real stack; "both up at once" is the
   acceptance test. `scripts/preflight.sh` looks and reports — it never kills.

## The seed/test stack

Throwaway infra (Postgres + MinIO + Tika + Ollama) for generating, ingesting
and testing the demo brain. Isolation recipe copied from `e2e/stack/`:
distinct project + container names (`mantle_demo_*`), loopback-only
non-default ports, project-scoped named volumes — no bind mounts, so it
physically cannot reach a real stack's `MANTLE_DATA_DIR`.

```sh
demo/scripts/stack-up.sh           # preflight → up --wait → bucket + embedder
demo/scripts/stack-down.sh         # stop, keep volumes
demo/scripts/stack-down.sh --wipe  # stop + wipe → next up is a fresh brain
```

| service  | host address      | notes |
|---|---|---|
| postgres | `127.0.0.1:56432` | pgvector, same init scripts as the real stack |
| minio    | `127.0.0.1:56900` | console `:56901`, bucket `mantle` pre-created |
| tika     | `127.0.0.1:56998` | file-ingest text extraction |
| ollama   | `127.0.0.1:56434` | embeddings; `embeddinggemma` pulled on up |

App services are deliberately absent: at seed time the API and workers run
from source on the host, pointed at these ports. The serve-time compose for
the demo host is a separate file (added in P7) — that one has the app
containers, hard `mem_limit`s, and a read-only Postgres role.

## Layout (grows with the phases)

```
demo/
  docker-compose.yml   seed/test stack (this file's rules above)
  scripts/             stack-up / stack-down / preflight
  world/               P1 — the world bible (cast, companies, vocabulary)
  generator/           P2 — deterministic content generator
  seed/                P3/P4 — ingest + behavioural-data runs
  check/               P6 — coverage gate + publish guard
  deploy/              P7 — serve-time compose + Caddy block for the demo host
```

The full plan — phases, testing layers, refresh cadence, and the v1
post-mortem this design answers — lives in the internal demo-v2 plan document.
