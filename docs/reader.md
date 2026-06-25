# Reader — "Reader", the web-page reader agent

The **Reader** is handed a specific URL and reads it. Where the
[Researcher](./research.md) goes out to the live web to *find* answers (planning
queries against Perplexity Sonar), the Reader is given a page — an article, a
doc, release notes, a pricing page — and pulls its content back as context for
the responder. It doesn't search; it reads the pages it's told to.

Companion docs:
- [`research.md`](./research.md) — the search twin (find pages on the open web).
- [`toolsmith.md`](./toolsmith.md) — the other holder of `web_fetch` (reads API docs).
- [`architecture.md` §9b](./architecture.md#9b-agent-delegation-invoke_agent) —
  the `invoke_agent` delegation path it rides on.

---

## 1. The flow

```
You → Saskia: "summarise what this page says — https://example.com/post"
   │  trace: responder_turn (Saskia)
   ├─ invoke_agent('reader', "<url + what to pull out>")
   │     └─ child trace: manual / child_agent  (Reader, depth 2)
   │          ├─ web_fetch(url)                 → readable text  [the page]
   │          ├─ web_fetch(url, offset=40000)   → next slice if long
   │          └─ summarises / excerpts → returns to Saskia
   └─ Saskia relays it; if it's worth keeping, she calls note_create → brain
```

Two layers, same as research: **`web_fetch` is the raw primitive** (one URL →
its text); **the Reader is the smart layer** that pages through long documents
and returns exactly what the task asked for (a summary, the facts, or verbatim
excerpts). Saskia orchestrates and decides whether to keep the result.

---

## 2. `web_fetch` — the raw primitive

[`packages/tools/src/builtins-toolsmith.ts`](../packages/tools/src/builtins-toolsmith.ts)
(shared with the Toolsmith, which uses it to read API docs).

| Arg | Required | Notes |
|---|---|---|
| `url` | ✅ | `http(s)` URL to fetch |
| `offset` | — | character offset to continue a long page (default 0) |
| `max_chars` | — | characters to return (default 40 000, max 80 000) |

How it reads and extracts a page, end to end:

1. **Plain HTTP GET** via `guardedFetch`
   ([`ssrf-guard.ts`](../packages/tools/src/ssrf-guard.ts)) — 25 s timeout, 5 MB
   body cap, UA `mantle-toolsmith/1.0`. The SSRF guard re-checks every redirect
   hop and blocks private / loopback / link-local / cloud-metadata targets, so a
   malicious page can't turn `web_fetch` into a probe of internal services.
2. **Content-type routing:**
   - **HTML** → [Apache Tika](../packages/files/src/tika.ts) (`PUT /tika`,
     `Accept: text/plain`) strips markup to readable plain text; if Tika is down
     or returns empty, a crude regex fallback drops `<script>`/`<style>`/tags.
   - **JSON / markdown / plain text** → returned as-is (no parsing).
3. **Slice + page** — returns `{ url, status, contentType, text, totalChars,
   offset, truncated }`. Long pages are read by calling again with a higher
   `offset`.

Returns `ok:false` (not a guess) when the fetch fails — blocked host, timeout,
4xx, or an empty body.

---

## 3. "Reader" — the agent

Defined in the [system manifest](../apps/web/lib/system-manifest/manifest.ts)
(prompt in [`prompts.ts`](../apps/web/lib/system-manifest/prompts.ts)); seed it
onto an existing brain with `pnpm -C apps/web seed:reader`.

| Field | Value |
|---|---|
| `slug` / `role` | `reader` / `custom` |
| `model` | `anthropic/claude-sonnet-4.6` (`READER_MODEL` to override) |
| tool groups | **`web-read`** (just `web_fetch`) |
| `params` | `temperature: 0.3` |
| persona | given a URL → `web_fetch` → page through long docs → return a faithful summary / facts / verbatim excerpts; report failures honestly; never fabricate page contents |

Deliberately **not** granted the search tiers (`web_search`/`web_search_pro` —
that's the Researcher) or `memory-core` — it works from the URL it's handed, the
way the Toolsmith works from docs. It's an `agents` row (not an `ai_worker`), so
`invoke_agent` runs its tool loop. It runs at delegation **depth 2**
(`MAX_AGENT_DEPTH`), so it can't sub-delegate. `isDelegate: true` wires it into
the persona's `memory_config.delegate_to` automatically.

---

## 4. Persistence — "Saskia decides"

Like the Researcher, the Reader **saves nothing** — it returns content. Saskia
decides whether it's worth keeping and, if so, calls `note_create`, which writes
a `note` node; the INSERT trigger fires the extractor so the kept content is
indexed into the brain. Throwaway lookups don't clutter the graph.

---

## 5. How it compares to other web readers

`web_fetch` is architecturally closest to **`curl` + Tika text extraction**, and
it makes two deliberate trade-offs worth knowing:

- **No JavaScript execution.** It reads the HTML the server sends — no headless
  browser. Static / SSR pages, docs, articles, JSON/RSS, and OpenAPI specs read
  well; a client-rendered SPA that ships an empty shell + JS comes back nearly
  empty. (Unlike Jina Reader / Firecrawl, which render the page first.)
- **Full-text extraction, not "reader mode."** Tika returns *all* the page's
  text, including nav/footer chrome — it doesn't isolate the article body the way
  Jina / Firecrawl / Mozilla Readability do. That's why the Reader's prompt leans
  on the model to summarise/excerpt rather than dump raw text.

The upside of both: it's **fully self-hosted and private** — the page never
leaves your infra (the SaaS readers proxy the URL through their service). If
JS-heavy sites or cleaner Markdown become a need, the upgrade is a
`web_fetch`-level change (a headless-render / readability step), which the
Toolsmith would inherit too — not a Reader-only fork.

---

## 6. Setup

1. An `openrouter` API key at `/settings/keys` (the Reader's model routes
   through it; `web_fetch` itself needs no key).
2. A reachable **Tika** sidecar (`TIKA_URL`, default `http://127.0.0.1:9998`)
   for clean HTML→text — the crude regex fallback covers it being down.
3. `pnpm -C apps/web seed:reader` **and** `pnpm -C apps/web seed:tool-groups`
   (the latter syncs the new `web-read` group's membership onto an existing
   brain). Fresh brains and the version-bump boot reconcile pick it up
   automatically.
4. **Restart `apps/agent`** so the loop sees the new agent.

Then ask Saskia to read a page and watch `/traces`: her `responder_turn` with an
`invoke_agent` step, and the Reader's child trace running `web_fetch`.

---

## 7. Files

| Concern | File |
|---|---|
| `web_fetch` primitive | [`packages/tools/src/builtins-toolsmith.ts`](../packages/tools/src/builtins-toolsmith.ts) |
| HTML→text (Tika) | [`packages/files/src/tika.ts`](../packages/files/src/tika.ts) |
| SSRF guard | [`packages/tools/src/ssrf-guard.ts`](../packages/tools/src/ssrf-guard.ts) |
| Agent + `web-read` group | [`apps/web/lib/system-manifest/manifest.ts`](../apps/web/lib/system-manifest/manifest.ts) |
| Reader prompt | [`apps/web/lib/system-manifest/prompts.ts`](../apps/web/lib/system-manifest/prompts.ts) |
| Seed wrapper | [`apps/web/scripts/seed-reader.ts`](../apps/web/scripts/seed-reader.ts) |
| Delegation bridge | [`packages/agent-runtime/src/invoke-agent.ts`](../packages/agent-runtime/src/invoke-agent.ts) |
