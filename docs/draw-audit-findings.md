# Draw workspace: audit findings

> Independent audit of `feat/draw-workspace` (7 commits on `v0.225.2`/`0b1553ae`),
> run against [draw-audit-handover.md](./draw-audit-handover.md) and
> [draw-plan.md](./draw-plan.md) on 2026-08-07. Method: the handover's own §6
> procedure, plus an attack session against the one function the whole safety
> argument rests on. Everything below is evidence, not inference, unless it says
> otherwise.
>
> **Verdict: do not merge yet.** The additive claim survives. The security claim
> does not: `acceptSceneSvg` is bypassable and stored XSS executes in three
> places, one of which is the owner's own authenticated session. Two further
> defects cause silent data loss. All are cheap to fix; none invalidate the
> design.

## 1. What the handover got right

Re-ran and confirmed:

| Check | Result |
|---|---|
| Content suite | 870/870 pass |
| Tools + manifest + help suites | 523/523 pass |
| `pnpm -r typecheck` | clean, all packages |
| `pnpm -C client/web build` | clean |
| I7, editor chunk stays draw-only | **holds, stronger than claimed.** The 1.78 MB excalidraw chunk appears in NO build manifest at all (pure lazy import). The only value-import of the package is `draw/[id]/draw-detail-client.tsx` via the wrapper; every other reference in the tree is `import type`. The list route never pulls it. |
| I1, drafts never cross a trust boundary | holds. `draft_scene` has exactly two readers, `getDraw` and `withDrawLock`. Share, export, print, MCP and extractor all read committed columns. |
| I2, no bytes in the scene blob | holds for every path in the repo (`normalizeScene` rebuilds `{elements, appState⊂6}`), though it is a top-level whitelist: element objects are stored verbatim and never inspected. |
| I5, owner isolation | holds. Every content function filters `ownerId` + `type='draw'`. The three id-only queries are guarded by a preceding owner-checked SELECT, byte-for-byte what `pages.ts` does. |
| I6, concurrency is pages-equivalent | holds. `withDrawLock` mirrors `withPageLock`; `evaluateDraftRev` is imported, not copied; conflict returns precede every UPDATE, so a stale `if_rev` mutates nothing. |
| I9, a bad commit clears the SVG | holds (`draws.ts:499,525`), with a consequence the handover missed, see §3.2. |
| Migrations 0144/0145 | enum rule obeyed (0145 never uses the new value), journal well-formed and consistent, **zero drift** between the SQL and `schema/draws.ts`, nothing else FKs to `draws`. The missing trailing newline in `_journal.json` is cosmetic: `.prettierignore:20` and `eslint.config.mjs:22` both exclude migrations. |
| Additive claim (§2 of the handover) | holds across all 25 modified files, with one exception in §4.1. |

The handover is unusually honest. Its gap list (G1 to G12) is accurate as far as
it goes, and every gap it declared unverified really was unverified. The findings
below are things it did not know, not things it concealed.

## 2. Blocker: `acceptSceneSvg` does not do what the branch believes (G5)

The handover invites an auditor to "try to construct an SVG that passes the
checks and still executes". Six of seven attempts passed the filter; three
executed. Payloads and harness: reproduced below, all confirmed in a real
browser injecting via `innerHTML`, which is exactly what
`dangerouslySetInnerHTML` does.

| Payload | Filter | Browser |
|---|---|---|
| `<image href="/x"/onerror="…"/>` | **passes** | **executes, no interaction** |
| `<svg …/onload="…">` nested | **passes** | **executes, no interaction** |
| `<a xlink:href="&#106;avascript:…">` | **passes** | **executes on click** |
| `<style>` page takeover | **passes** | **restyles the whole page** |
| external `<image href="https://…">` | **passes** | fetches (arbitrary egress) |
| `<set attributeName="xlink:href" to="&#106;avascript:…">` | **passes** | did not fire |
| `<animate onbegin="…">` (control) | rejected | n/a |

Two independent root causes, both classic:

1. **The handler regex is `/\son[a-z]+\s*=/i`, requiring whitespace before
   `on`.** The HTML tokenizer treats a solidus in "before attribute name" state
   as a separator, so `<image href="/x"/onerror="…">` parses `onerror` as a live
   attribute while the regex never sees it. Any element, any handler.
2. **`/javascript:/i` runs against the raw string, but the HTML parser decodes
   character references in attribute values.** `&#106;avascript:` stores as a
   literal `javascript:` URL in the DOM. Verified: after injection,
   `getAttribute('xlink:href')` returns `javascript:…`, and a genuine click
   (not a synthetic event) ran it.

Beyond script execution, an inline `<style>` in inline SVG is **not scoped to the
SVG**. The payload hid an unrelated element by id and painted a fixed
full-viewport overlay over the entire page. Screenshot evidence: the simulated
share page rendered as a solid red "DEFACED" sheet. That is defacement and
clickjacking on the app's own origin without any script at all.

### Why this is worse than "self-XSS"

The stored SVG is injected inline in **three** places, not one:

- `client/web/app/(app)/draw/draws-client.tsx:289`, the list preview, inside the
  **owner's logged-in app session**.
- `packages/web-ui/src/share/draw-presenter.tsx:18`, the public `/s` page, served
  same-origin with the authenticated app.
- `server/web/server/pages/print.ts:77`, interpolated into the print template,
  which `renderUrlToPdf` loads in **headless Chromium carrying an owner render
  cookie** (`buildInternalRenderCookie`). A payload there runs authenticated as
  the owner, server-side, with the whole API reachable.

There is no second layer: no Content-Security-Policy anywhere in the tree
(confirmed by grep; this predates the branch and applies to page shares too).

### What limits it today

Only the owner can write `draws.scene_svg`. Verified independently: `insert(draws)`
/ `update(draws)` appear in exactly one file, with six call sites, all in the four
`getOwnerOr401` routes under `/api/draws`. `DRAW_TOOLS` is read-only, and
federation, peer and `/api/team*` contain no draw write path at all. Upstream also
closes the obvious amplification: element links go through
`@braintree/sanitize-url` before reaching the exported `<a href>`, and the
snapshot is serialized with `svgEl.outerHTML`, which escapes text content, so a
malicious imported `.excalidraw` scene cannot smuggle markup through
`exportToSvg`.

So the practical exposure is an owner-authenticated write, whether by the owner,
by CSRF against their session, or by anything that gets to speak to the API as
them. That is a real threat model, and it is precisely the one the file's own
docstring claims to defend: "it arrives over the API like any other payload …
so it gets the same trust as user HTML: none". By its own stated standard, it
fails.

### Recommended fix, in order of value

1. **Stop injecting the SVG inline. Render it as `<img src=…>`.** The snapshot
   already has fonts inlined, so it renders standalone. Image context executes no
   script, applies no page-level CSS, and blocks external subresource loads. One
   change closes every payload above at all three sites, permanently, regardless
   of what the filter misses next. Cost: no text selection in the preview.
2. Add a CSP to `/s` and `/print` (`default-src 'none'; img-src 'self' data:;
   style-src 'unsafe-inline'` or tighter). Independently useful: page shares are
   currently unprotected too.
3. If inline injection is kept, replace the blocklist with a parse-and-serialize
   allowlist (DOMPurify with the SVG profile). A regex blocklist over HTML is the
   wrong shape of tool, and each fix below is one more thing the next author has
   to remember. As an interim, at minimum: allow `/` as a separator
   (`/[\s/]on[a-z-]+\s*=/i`), reject `&#` and `&#x` inside any `href`/`xlink:href`
   value, reject `<style`, and reject non-`data:image`, non-`#` URL references.
4. Add every payload in this section to `scene-svg.test.ts` as a regression test.

## 3. Silent data loss, two distinct paths

### 3.1 An embeddable in the scene destroys the snapshot

Not previously known. Excalidraw 0.18.1 fully supports embeddable elements
(YouTube, Vimeo, Figma; confirmed present in the pinned bundle), created by
pasting a supported link. `renderElementToSvg` emits a `<foreignObject>` for
them unless the caller passes `renderEmbeddables: false`; the commit path
(`draw-detail-client.tsx:297`) passes no such option. So `exportToSvg` returns
SVG containing `<foreignObject>`, `acceptSceneSvg` rejects it, and the snapshot
is stored as null. Per I9 that also **wipes a previously good snapshot**. Result:
paste a YouTube link onto a working drawing, commit, and the list preview, the
live share link, SVG export and PDF export all go blank, with no error anywhere.

Fix is one option in the export call: `renderEmbeddables: false`, which makes
upstream emit a plain `<a>` instead.

### 3.2 A failed or oversized snapshot commits as success

`exportToSvg` failures are swallowed client-side
(`draw-detail-client.tsx:310-312`), the commit proceeds without an SVG, the
server clears the column, and the toast says "Committed". The server response
even carries `hasSvg: false` (`draws.ts:538`) and the client ignores it.

The same silent outcome is reachable through the char/byte mismatch the handover
flags as intentional, but with a consequence it did not state. The commit route's
`z.string().max(SCENE_SVG_MAX_BYTES)` counts UTF-16 code units while
`acceptSceneSvg` counts bytes, so the zod cap is strictly **looser**, never
tighter. A multibyte payload between the two limits returns HTTP 200, stores
null, and destroys the previous snapshot. Worst case roughly 18 MB of body is
parsed and held before being discarded.

Both deserve the same one-line fix: surface `hasSvg: false` in the UI ("Committed,
but the preview could not be generated") rather than reporting unqualified
success.

## 4. Smaller corrections to the handover's own claims

1. **The manifest change is not purely additive.** `manifest.ts:953` adds
   `'draw-read'` to an existing agent's `toolGroups`, granting two new tools to an
   already-deployed agent. That is the normal manifest workflow, but it means
   `checkSystemIntegrity` reports drift on every existing brain until
   `applyManifest` is re-run. "Deploy is a no-op for existing installs" is not
   quite true.
2. **I4's "commitDraw is the only notify site" is wrong.** Migration
   `0018_node_ingested_trigger.sql` fires `pg_notify('node_ingested')` on every
   non-branch `nodes` INSERT, so `createDraw` queues an extraction of a brand-new
   empty drawing (`scene_text` is `''`, so the extractor summarizes the title).
   One wasted LLM call per drawing created. Nothing is per-stroke, so the
   invariant's intent holds, but the claim as written does not.
3. **`pnpm verify` fails today**, and not for an environment reason. `pnpm lint`
   is clean (1 pre-existing warning), `pnpm -r typecheck` is clean, but
   `pnpm format:check` fails on three of the branch's OWN new files:
   `client/web/app/(app)/draw/draws-client.tsx`, `packages/content/src/draws.ts`,
   `packages/tools/src/builtins-draws.ts`. Run `pnpm format`. G10 is not just
   unverified, it is red.
4. **The kill path is understated.** Postgres cannot remove an enum value, so
   backing out is `DROP TABLE draws` **plus** `DELETE FROM nodes WHERE
   type='draw'` plus a permanently dead enum member. Same one-way door as
   `formula`/0136, so it is the established cost, not a new one.
5. **The rebase has a silent trap.** `git merge-tree` confirms exactly two
   conflicts, both trivial textually: `server/web/app/api/export/[id]/route.ts`
   (main's `getOwnerOr401` → `getOwnerForAsset` vs the branch's added imports)
   and `client/web/components/export/export-menu.tsx`. The trap is in the second:
   main's v0.225.3 fix wraps export links in `assetUrl(...)`, and the branch's new
   `draw` menu entries must be wrapped too, or drawing downloads 401 from the
   detached client. **The merge resolves cleanly without that fix.**
6. **Export route nits.** The `?format=pdf` branch now calls `getDrawSvg` on every
   request before the page path. Harmless for correctness (a page node can never
   return non-null: `draws.ts:283-291` filters on both `draws.nodeId` and
   `nodes.type='draw'`) and negligible next to spawning Chromium, but the route
   docstring at `route.ts:18` still says "page only", and a draw with no committed
   snapshot falls through to 404 with `"not found or not a page"`.
7. **G11 answered: there is no body limit.** `server/web` runs under
   `@hono/node-server` with no `hono/body-limit` and no framework default. The
   only cap anywhere is `infra/caddy/Caddyfile:20-22` (`max_size 100MB`), which
   applies only behind the shipped Caddy. The autosave PUT schema is
   `z.record(z.string(), z.unknown())` with no depth, count or size bound, and
   `normalizeScene` caps neither element count nor element size, on a path that
   fires every 1.5 s straight into an unbounded `jsonb` column.
8. **`EMPTY_SCENE` is a shared mutable module-level object**, handed out by
   reference as `DrawDetail.scene` from `getDraw:255` and `updateDraw:364`.
   Nothing mutates it today; it crosses requests.
9. **`draw_get` loads the whole draft into memory** to emit one boolean
   (`builtins-draws.ts:88`). Correct, but `getDrawSceneText` would have sufficed
   and it is one careless spread from leaking a draft over MCP.

## 5. Revised pre-merge checklist

Blocking:

- [ ] **§2**: stop injecting stored SVG inline (prefer `<img>`), or replace the
      blocklist with an allowlist sanitizer, and add the payloads as tests
- [ ] **§3.1**: pass `renderEmbeddables: false` to `exportToSvg`
- [ ] **§3.2**: surface `hasSvg: false` instead of reporting a clean commit
- [ ] **§4.3**: `pnpm format`, then `pnpm verify` on the workstation (G10)
- [ ] G1: commit an automated lifecycle test (still the biggest process gap; there
      is no `draws.test.ts` at all)
- [ ] Rebase, wrapping the new draw export items in `assetUrl(...)` (§4.5)

Worth doing, not blocking:

- [ ] A CSP on `/s` and `/print` (fixes page shares too)
- [ ] A size/element-count bound on the draft PUT (§4.7)
- [ ] G2 pin-bump corpus test, G3 image-paste browser run, G9 theme and mobile pass
- [ ] Decide G4 (orphaned draft images) and G8 (share-before-commit UX)
- [ ] Fix the stale docstring and the misleading draw 404 (§4.6)

Not blocking, informational: §4.1 (manifest drift on existing brains), §4.2 (one
extraction per created drawing), §4.4 (enum is permanent), §4.8, §4.9.
