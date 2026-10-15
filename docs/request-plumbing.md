# Request plumbing: one body reader, one error answer, rate limits on the row

A10 part 2 (the gateway survey's folds 1 and 2; the survey is a dev-brain
page), and A10 #8 (the survey's finding 8, rate limits). Jobs every route of
the HTTP tier did for itself, each folded behind one gateway, proved by
recording every answer before the move and holding every answer to it
after, and pinned so the scattered form cannot come back. Part of the actor
work: [actors.md](actors.md) links here. Rate limits: [below](#rate-limits-a10-8).

## Fold 1: one body reader

### Before

The gate refused a body that DECLARED a Content-Length over the route's
ceiling (`server/web/server/middleware/gate.ts`, `bodyCeilingFor` in
`server/web/lib/body-limit.ts`). A chunked body declares nothing, and 186
route files read the body themselves: 178 with `req.json()` (most with
`.catch(() => ({}))`, some with `null`, a few in a try block), the rest with
`req.formData()`, `req.text()` or the stream. Only 10 read through the cap
(`readJsonCapped`). So any signed-in caller could stream a body of any size
into most write routes, and a body that was not JSON became `{}` and failed
later with some other message, or was accepted as if no field was sent.

### After

- **The loader caps every read** (`server/web/server/route-loader.ts`): it
  hands each handler a request whose body reads through `capRequestBody`
  (`server/web/lib/body-limit.ts`) at `bodyCeilingFor(path)`. `json()`,
  `text()`, `formData()`, `arrayBuffer()` and the stream all stop at the
  ceiling with `BodyTooLargeError` (413), and the source is cancelled
  there. A handler that swallowed the error, or wrapped it in its own and
  threw, still answers 413 (`bodyWentOver`). Nothing is read until a
  reader asks. The capped request is built from the request's parts (url,
  method, headers, signal), never `new Request(req, init)`: behind
  `serve()` the handler's request is @hono/node-server's lightweight
  stand-in, which undici refuses as a Request input. The ceiling is the
  one of the decoded path Hono matched (`c.req.path`), in the loader and in
  the gate. A streamed upload path (no ceiling: the uploads that spool to
  disk under their own caps) gets its request as before; a multipart route
  that calls `formData()` has its file cap plus the framing as its ceiling
  (`MULTIPART_CEILINGS`).
- **One reader** (`server/web/lib/read-body.ts`):
  - `readBody(req, Schema)`: the parsed data, or `BadBodyError` with the
    first problem (`firstIssue`), answered 400 `{ error }` by
    `answerAppError`;
  - `readJson(req)`: the JSON value, for a route that checks it itself;
  - an empty body reads as `{}` (or the route's `empty` value; `refuseEmpty`
    where every call sends one), so an action with no fields needs no body,
    as before;
  - a body that is not JSON throws `BadBodyError('invalid JSON')`: 400
    `{ "error": "invalid JSON" }`, the one text;
  - `maxBytes`: the JSON body of an upload path (`/api/files/files` and
    `/api/assistant/turn`, whose multipart branch streams under its own
    cap) reads under the JSON ceiling, which the loader does not apply
    there.
  - NUL characters are kept as sent (no route used `readJsonNoNul`).
  - `invalid`: what a body that is not JSON reads as, for the two routes
    whose body is optional and that answer whatever was sent (sign-out,
    the turn's Stop), and for `readJsonNoNul` (`server/web/lib/strip-nul.ts`,
    the push login routes), which reads through `readJson` with
    `empty: null, invalid: null` (it had a reader of its own,
    `readJsonCapped`, now gone).
- **The codemod**: 188 route files moved (43 onto `readBody`, where the
  route's own refusal was already `{ error: firstIssue(...) }` 400; the
  rest onto `readJson`, keeping the route's own schema check and its own
  refusal text), the 10 `readJsonCapped` routes among them, plus three lib
  readers (`app-runner.ts`, `token-login.ts`, `workspaces.ts`). A route that read
  inside a try block whose catch answers the write's errors reads before
  the try now.

Named exceptions, each with its reason, in `eslint-rules/route-plumbing.mjs`
(`BODY_READ_ALLOW`): the multipart uploads (`formData`, on upload paths
with their own caps), the package import (streams `req.body` to disk), the
two OAuth form posts, and the `/api/v1` page PATCH that checks two fields
of the raw text and hands the same bytes to the page route.

### The proof

`server/web/server/a10-body-sweep.test.ts` drives every write route of the
manifest (POST, PUT, PATCH, DELETE) through the full pipeline as the owner,
a member where the row admits members, and nobody on a public row, with
six bodies: valid (made from the route's own zod schema, found at the read
and kept in `server/web/server/__snapshots__/a10-body-sweep.bodies.json`),
malformed JSON, empty, NUL in every string, a JSON array, and a chunked
body 1 MB over the route's ceiling. 2178 cells, status, content type,
location and body each, recorded on v0.300.41 before the move
(`server/web/server/__snapshots__/a10-body-sweep.txt`, written once with
`A10_BODY_SWEEP_RECORD=1`). After the move every cell answers as recorded
or is a named change, listed cell by cell with its answer on main and now
in `server/web/server/__snapshots__/a10-body-sweep-changes.txt`; the test
fails on a change no kind names.

The named changes of fold 1 (418 of 2178 cells; fold 2 names 9 more, below;
every other cell byte for byte):

| Kind                                               | Cells | What                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chunked-413                                        | 207   | a chunked body over the ceiling answers 413 `body-too-large` where the route read it in full and answered whatever `{}` gave it (a 400 field message, a 404, a 500)                                                     |
| bad-json-400 (malformed)                           | 200   | `{"a":` answers 400 `{"error":"invalid JSON"}` where the route read `{}` or null and failed later with another message, or refused it with a text of its own (`invalid body`)                                           |
| bad-json-400 (malformed, accepted as `{}` on main) | 7     | the same, where `{}` passed and the route went on as if no field was sent: the docs collections (3), the embedding settings (3) and the network key (the turn cancel and sign-out answer as on main again, fix round 1) |
| bad-json-400 (empty)                               | 2     | `PATCH /api/mcp-settings` and `PATCH /api/team-admin/settings` refuse an empty body with the one text where they said `invalid body`                                                                                    |

Fold 1 changes no valid, NUL or array cell. The A4 sweeps
(`server/web/server/a4-guard-sweep.test.ts` and its recorded files, the
auth, member, role and link sweeps) are byte for byte: they stop at the
caller's answer, before any body is read.

### The pins

- Scoreboard (`scripts/arch-scoreboard.pins.json`): `routeBodyReadFiles`,
  route files reading the request body directly, 186 on main, pinned at 0;
  `routeBodyReadAllowed`, the named files, pinned at 9.
- ESLint (`eslint-rules/route-plumbing.mjs`, `no-direct-body-reads`): a
  call of `json()`, `text()`, `formData()`, `arrayBuffer()` or `blob()`, or a
  read of `.body`, on a route handler's request is an error outside the
  named files. `eslint-rules/arch-lints.test.ts` holds the count at 0 and
  the named list to the files that still read.

### The multipart routes (closed in fix round 1)

The multipart uploads that use `formData()` (`/api/assistant/turn`'s
attachment, `/api/assistant/transcribe`, `/api/tables/:id/import`,
`/api/profile/photo` and `/logo`) sat on upload paths with no loader
ceiling, so `formData()` buffered a chunked body of any size before their
own size checks ran (the chat routes are open to member logins). Each has
a ceiling now (`MULTIPART_CEILINGS`, `server/web/lib/body-limit.ts`): the
chat attachment and the spreadsheet import the buffered upload cap
(64 MB) plus 1 MB of framing, a voice clip 25 MB plus the framing, the
photo and the logo 1 MB (twice the image cap, the routes' own declared
refusal). The body sweep names the cells that moved (`chunked-413`).

## Fold 2: one error answer

### Before

116 route files had their own catch. 86 of them put a caught error's text
in the reply (`errorTextReplies`, `eslint-rules/route-plumbing.mjs`),
mostly as a 400: a database error's SQL, a provider's text, a plain fault
(`server/web/app/api/contacts/route.ts`, `journal`, `events`,
`tables/[id]/commit`), and once in a redirect URL (the Microsoft sign-in
callback). 15 catches re-threw the workspace refusal by hand
(`if (isScopeWriteRefusal(err)) throw err;`), and `treeErrorResponse`
mapped the folder errors in 8 routes while the tools mapped them again.
A domain function told the caller what was wrong with a plain `Error`, so
nothing could tell a refusal the caller should hear from a fault.

### After

- **One table** (`packages/std/src/domain-errors.ts`, `DOMAIN_ERRORS`):
  error class to HTTP status, public text and the reason it is public.
  Each class registers its row where it is defined (`defineDomainError`),
  so the table needs no package above `@mantle/std`. A class is matched on
  the error or up to three causes below it, by its own row or a parent's.
  Rows today:

  | Class                                          | Status                                                              | Says                                      | Reason                                                 |
  | ---------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
  | `InputError` (std)                             | 400                                                                 | its message                               | the caller sent a value the domain refuses             |
  | `ConflictError` (std)                          | 409                                                                 | its message                               | the write meets something already there (a name taken) |
  | `BadBodyError` (`server/web/lib/read-body.ts`) | 400                                                                 | its message                               | the body is not JSON, or not what the route reads      |
  | `TreeError` (content tree)                     | 404 not-found, 409 conflict, 410 gone (`code: 'gone'`), 400 invalid | its message                               | a folder write cannot be done as asked                 |
  | `TreeVisibilityError` (content tree)           | 409                                                                 | `{ error: 'visibility', changes, total }` | the write changes who can see items: confirm first     |
  | `FormulaSpecError` (content formulas)          | 400                                                                 | `{ error, errors }`                       | the spec has problems; the list says which             |
  | `TableTooLargeError` (tabledb)                 | 400                                                                 | its message                               | more rows than a whole read or an import may take      |

  The later tranches added a row for each typed error a route had mapped by
  hand, with the body that route gave it (`server/web/server/domain-error-rows.test.ts`
  holds each to its old answer byte for byte):

  | Class                                                            | Status                         | Body beyond `error`                     |
  | ---------------------------------------------------------------- | ------------------------------ | --------------------------------------- |
  | `AppSourceLimitError` (content apps)                             | 400                            |                                         |
  | `AppDraftConflictError` (content apps)                           | 409                            | `reason: 'conflict'`                    |
  | `NoGreenBuildError` (content apps)                               | 409                            |                                         |
  | `AppRestoreDraftError` (content apps)                            | 409                            | `reason: 'draft'`                       |
  | `AppDbMissingError` (content app-broker)                         | 409                            | `reason: 'db-missing'`                  |
  | `AppSnapshotBudgetError` (content app-snapshots)                 | 409                            | `reason: 'budget'`                      |
  | `AppSnapshotRefusedError` (content app-snapshots)                | 409                            | `reason: 'no-data'` from a restore      |
  | `AppTrashRefusedError` (content app-trash)                       | 409                            |                                         |
  | `AppPackageError` (content app-package)                          | 400                            | `reason: 'bad-package'`                 |
  | `TableSnapshotRefusedError` (content table-snapshots)            | 409                            |                                         |
  | `TableRestoreDraftError` (content table-snapshots)               | 409                            | `reason: 'draft'`                       |
  | `AppBoundTableError` (content tables)                            | 409                            |                                         |
  | `TableRevConflict` (content table-broker)                        | 409                            | `current_rev`                           |
  | `ContactShareRefusedError` (content contact-shares)              | 400                            | `reason` (the refusal's own)            |
  | `FormulaNotFoundError` (content formulas)                        | 404                            |                                         |
  | `UploadTooLargeError` (files)                                    | 413                            | `maxUploadBytes`; a video gets the hint |
  | `TelegramTokenError` (`server/web/lib/agent-telegram.ts`)        | 404 a chat not found, else 400 | `code` when set                         |
  | `FireRefused` (`server/web/lib/heartbeats.ts`)                   | 403                            |                                         |
  | `PdfRendererUnavailableError` (`server/web/lib/render-pdf.ts`)   | 503                            | (logged where thrown)                   |
  | `ApprovalRefusedError` (tools pending-approval, A5 steps 6c, 6d) | 403                            |                                         |

  `CloneAgentError` (`server/web/lib/agents.ts`) is an `InputError`.

- **One answer** (`server/web/server/app-error.ts`, `answerAppError`): a
  redirect, a refusal taken at the read, a refusal by the one mapper
  (`mapAccessError`), a body over its ceiling, then the table, then busy
  (409), and anything else the one opaque 500 `{ "error": "internal error" }`
  with a log line. The tool surface's public text (`publicErrorMessage`,
  `@mantle/std`) reads the same table, so a route and a tool say the same
  words. The access mapper (`packages/std/src/access-error.ts`) is not
  duplicated: refusals stay its own.
- **Domain refusals got their class.** The checks the moved routes'
  callers hear were plain `Error`s; they are `InputError` now, same text:
  the contact checks (an email or domain, a country code, a name), the
  journal date and gap answer, the event dates, and the file and folder
  move and copy refusals (`packages/files/src/move-copy.ts`). A name
  already taken is a `ConflictError` (409, as the routes answered it by
  matching `already exists` in the text): `writeFile`, `renameFile`,
  `moveFile`, `renameFolder`, `moveFileById`, `moveFolderById`. The copy
  and the folder rename keep their 400 (`InputError`), as before.
- **The first tranche moved** (19 route files): the catches that only
  mapped errors are gone (the try unwrapped where nothing else was left),
  the 15 `isScopeWriteRefusal` re-throws and every `treeErrorResponse`
  catch with them (`treeErrorResponse` itself is deleted from
  `server/web/lib/tree-route.ts`). Files: `contacts`, `contacts/[id]`,
  `journal`, `journal/[id]`, `journal/[id]/resolve`, `events`,
  `events/[id]`, `formulas`, `formulas/[id]`, `files/files`,
  `files/files/[id]`, `files/folders`, `files/folders/[id]`,
  `tree/[kind]/move`, `tree/[kind]/folders`, `tree/[kind]/folders/[id]`,
  `pages`, `pages/[id]/move`, `tables/[id]/commit`. A catch that maps a
  case of its own without the error's text stays (a unique violation's
  fixed 409, an upload over its cap).
- **The later tranches moved** (44 more route files; 58 of the 86 in all,
  plus the re-throw and `treeErrorResponse` files): every route file whose
  catch put a caught error's text in a reply, except the 28 named below.
  - The typed catches (a class mapped to its status by hand, rethrowing the
    rest) are gone, each class answered by its row above: the app draft,
    publish, duplicate, export, snapshots, restore, trash restore and
    package import; the table history and restore; the contact shares; the
    PDF export; Fire now; the Telegram link and chat routes; the assistant
    clone of `users/[id]/agent`; the upload's 413 (`files/files`, whose
    multipart parse errors are now an `InputError` in
    `server/web/lib/upload-stream.ts`, 400 with the parser's text).
  - The slug-taken catches keep their fixed 409 and throw the rest:
    `agents`, `ai-workers`, `heartbeats`, `keys`, `model-pools`,
    `settings/worker-groups`, `skills`, `tool-groups`, `tools`.
  - The catch-alls are gone: `tools/[id]`, `heartbeats/[id]`,
    `pdf-passwords`, `peers`, `pending/[id]`, `runners/[id]`, `profile`,
    `studio/prose`, `studio/reset`, `config/adopt`, `config/adopt-all`,
    `formulas/[id]/evaluate`, the `tables/[id]` `draft`, `draft-ops`,
    `export` and `rows`, and the OpenAPI connector create. Two files keep
    a catch of their own but lost this one: the import's write
    (`tables/[id]/import`) and the MCP connector create (`mcp-connectors`).
  - The checks their callers hear became `InputError` (same text): the
    tool edit and delete refusals (`packages/tools/src/crud.ts`), the
    schedule checks (`packages/runtime/src/heartbeats/schedule.ts`), the PDF
    password and the peer's base URL and token, the preference checks
    (timezone, locale, reminder channel, app and account ids), the prose
    field, entity and version checks (`server/web/lib/studio/prompt-versions.ts`),
    the manifest adopt refusals (an unknown slug, no key, no persona), the
    table op checks (`packages/tabledb/src/ops.ts`, a tab that is not there
    in `engine.ts` and `window.ts`), the whole-grid save over a workbook,
    the commit with no draft, and the connector create checks (a connector
    already there is a `ConflictError` for MCP, 409 as the route matched
    it, and an `InputError` for OpenAPI, 400 as before).
  - The commit with no draft (`tables/[id]/commit`): the first tranche
    turned its plain `Error` into the opaque 500; it is an `InputError` now,
    400 with its text, as on main.
- **The Microsoft callback**
  (`server/web/app/api/microsoft/oauth/callback/route.ts`): a failed token
  exchange or account write redirects to `/settings/microsoft?error=` with
  the fixed sentence "Connecting your Microsoft account failed. The details
  are in the server log." where it carried the error's text (cut at 200
  characters); the error is logged
  (`server/web/app/api/microsoft/oauth/callback/callback-error.test.ts`).

### The proof

`server/web/server/a10-error-sweep.test.ts` drives every route of the 91
files fold 2 moves (the 86, plus the re-throw and `treeErrorResponse`
files; `server/web/server/__snapshots__/a10-error-sweep.files.json`), every
method, as the owner with its valid body, and a forced failure: once the
handler has read its caller, every use of the database throws the cell's
fault (a plain error, a drizzle query error over a Postgres error, the
workspace refusal, `BusyError`, the four `TreeError` codes and
`TreeVisibilityError`). 1314 cells, recorded before the move
(`server/web/server/__snapshots__/a10-error-sweep.txt`). After: every cell
as recorded, or a named change
(`server/web/server/__snapshots__/a10-error-sweep-changes.txt`):

| Kind                          | Cells | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opaque-500                    | 56    | a plain or a database error, whose text the route put in its reply, answers the opaque 500 (each for both faults). First tranche: POST and PATCH of `contacts`, `events`, `journal` (and `journal/:id/resolve`), PATCH `formulas/:id`, PATCH and POST `files/files/:id` and `files/folders/:id`, POST `tables/:id/commit`. Later: POST `agents`, `ai-workers`, `keys`, `skills`, `tool-groups`, `settings/worker-groups`, `config/adopt`, `config/adopt-all`, `formulas/:id/evaluate` (a 404 before), `tables/:id/draft-ops`; PUT `tables/:id/draft`; PATCH `heartbeats/:id`, `pending/:id`, `tools/:id`; DELETE `tools/:id` |
| opaque-500 (an earlier fault) | 18    | `POST /api/pdf-passwords` and `POST /api/runners/:id` failed on a setting the sweep leaves unset (the vault's master key, the runner's database) before the forced fault, and said that text (a 400 and a 500); the opaque 500 now, for every fault                                                                                                                                                                                                                                                                                                                                                                          |
| domain-by-table               | 516   | a domain error answers as the table says where a hand catch gave it another status: the folder errors and the visibility list where a route put their text in a 400 or mapped none (the opaque 500), busy 409 where cells said it in a 400, and the workspace refusal 403 on `POST /api/tables/:id/commit` (it said the refusal's text in a 400)                                                                                                                                                                                                                                                                             |

Most domain-by-table cells are forced: a route that never meets a
`TreeError` answers one by the table now, where it answered the opaque 500. The body sweep sees the same move from its side: 28 cells
`opaque-500 (fold 2)` (the database stand-in's plain error, or the unset
master key, whose text was the reply), and 1 cell `input-400 (fold 2)`:
`POST /api/config/adopt` with the sweep's valid body answers its refusal
"No persona agent to adopt onto." as a 400 where it said it as a 500.
Every other cell of both sweeps is byte for byte, and the A4 sweeps are
unchanged.

Named changes the sweeps do not force (a domain error a route answered
by its catch-all, now by its row): `formulas/:id/evaluate` answers a
stored spec that no longer validates 400 with its list (`FormulaSpecError`)
where it said 404; `config/adopt` and `config/adopt-all` answer their
refusals 400 where they said 500; `tables/:id/draft-ops`, `draft` and the
import answer an app table 409 (`AppBoundTableError`, as the restore did)
where they said 400, and the import's own errors without the
`import failed: ` prefix; `tables/:id/draft-ops` answers a revision that
kept changing past the retries 409 with `current_rev` (`TableRevConflict`)
where it said 400; `tables/:id/rows` answers a tab that is not there 400
where it said 500; the Telegram routes and the assistant clone answer a
fault the opaque 500 where they said a fixed sentence ("Could not link the
bot.", "Could not update the chat.", "Could not create the assistant.").
A route that did not map a class at all now answers it by its row where it
answered the opaque 500 (an `AppDbMissingError` on a restore, say).

### The pins

- Scoreboard: `routeErrorTextFiles`, route files putting a caught error's
  text in a reply outside the named list, pinned at 0;
  `routeErrorTextAllowed`, the named files, 86 on main, 72 after the first
  tranche, 28 after fold 2, pinned at 31 since fix round 1 widened the
  count (below).
- ESLint (`eslint-rules/route-plumbing.mjs`, `no-error-text-replies`): such
  a catch is an error in a route file outside `ERROR_TEXT_ALLOW`.
  `eslint-rules/arch-lints.test.ts` holds the list to the files that still
  do it, so it only shrinks, and `eslint-rules/route-plumbing.test.ts`
  holds every reason to `PUBLIC:` or `NOT_YET:`.

### What stays named

31 route files keep the error's text in a reply, each with its reason in
`ERROR_TEXT_ALLOW`:

- `PUBLIC` (25): the text is the answer of a service the owner set up and
  came to test or fix. The model tests (`agents/[id]/test/chat`, the seven
  `ai-workers/[id]/test/*`, `studio/sandbox`, `embedding/test`); the
  connectors' own servers (`mcp-connectors/[slug]/sync`,
  `mcp-connectors/[slug]/oauth/start`, `openapi-connectors/[slug]/sync`,
  `openapi-connectors/preview`, and the `oauthError` of
  `mcp-connectors` after a create); the dev console (`dev-tools/mcp`,
  `dev-tools/proxy`); the MCP health check (`mcp-status`); the push relay
  (`push/reset`); the speech provider's 422 (`assistant/transcribe`);
  Prettier's syntax error (`apps/[id]/format`); the spreadsheet parser
  (`tables/[id]/import`, its `parse failed: ` only); the authorization
  server's answer on the page the browser lands on after an MCP sign-in
  (`mcp-connectors/oauth/callback`); SQLite's text about the owner's own
  schema script (`apps/import`). The speech provider's text and a failed
  turn's text go to an Admin user only: a member hears a fixed sentence
  and the text stays in the log (fix round 1).
- `NOT_YET` (6 + 1): the route answers a dialog in a shape of its own,
  and the move needs the client (jackdaw) first. `/api/docs/collections`,
  `/api/docs/collections/[id]`, `/api/docs/collections/all`, `embedding`,
  `embedding/rebuild` and `network/key` answer `{ ok: false, message }`
  with status 200 to a settings dialog; `assistant/turn` puts a failed
  turn's text (mostly the provider's answer) in the chat of an Admin
  user. The recipe, once the client reads the
  one error answer: give the domain checks `InputError` (or a class with a
  row), delete the catch, run both sweeps and name the changes, take the
  file off the list and lower the pin.

The tool surface reads the table through `publicErrorMessage`; the tools'
`visibilityRefusal` (`packages/tools`) still words the visibility list for
a model itself.

## Fix round 1

An independent audit of the branch found the following; each is fixed and
tested here.

- **The real listener (H1).** `capRequestBody` built its request with
  `new Request(req, init)`, which undici refuses for the lightweight
  request @hono/node-server hands the app, so every POST, PUT and PATCH
  answered 500 behind `serve()` while every in-process test passed. It is
  built from the request's parts now, and
  `server/web/server/serve-listener.test.ts` drives the loader and the
  whole app through a real `serve({ overrideGlobalObjects: false })`
  listener on an ephemeral port: a JSON, an empty, a malformed and a form
  POST, a multipart upload, and chunked bodies over their ceilings. (A
  client still writing a large body when the 413 is sent may see the
  socket reset before it reads the answer; that is the transport, the same
  on main, and the test sends again on such a reset.)
- **Refusals that had turned opaque (M2).** The Files refusals the folder
  and file routes answered 400 with their text (the files root, a folder
  Mantle makes, a name with nothing a folder can be called, a parent
  outside the files root or not there, a folder of another kind, a folder
  too deep, the indexing switch on a node not there or of another kind)
  are `InputError`s, 400 with the same text. The run engine's refusal of a
  Runners action (no such run, not in a state for it: DBOS's own error) is
  `RunActionError` (`server/web/lib/runners.ts`), 500 with its text as the
  route said it; a fault of the engine's database stays the opaque 500. A
  formula id that is not a uuid is `FormulaNotFoundError` (404) where the
  database's cast error said its SQL. The other routes fold 2 moved to the
  opaque 500 throw nothing else a caller must read: their plain errors are
  inserts that returned no row, a key the vault cannot encrypt without its
  master key, and the database's own errors.
- **Multipart ceilings (M3)**: above.
- **Bodies sign-out and Stop take (L4).** `POST /api/auth/logout` and the
  turn's cancel read a body that is not JSON as none (`invalid: null`), as
  on main: sign-out clears the cookie and answers 200.
- **The count of error-text replies (L5)** saw only `.json(` replies. It
  sees a route's own `json()` and `bad()` helpers, an HTML page, a
  `return` of anything, and an `error:` or `message:` field (an item of a
  `failed` list) now, which found five more files: the model combos and the
  formula seed put a fault's text in their `failed` lists, and say a domain
  error's text or a fixed sentence now (`itemErrorText`, `@mantle/std`);
  the other three are named above (the pin went 28 to 31).
- **The chat for members (L6)**: above.
- **The gateway lens (L7).** The hand status mappers are rows of the one
  table now, each answering byte for byte what its mapper did
  (`server/web/server/domain-error-rows.test.ts` compares the whole wire
  answer): `WsError` and `GrantError` (`wsRoute`, `grantsRoute`, which keep
  running the rule-in-query call and answering the result), `LinkRefusedError`,
  `ShareInputError` and `TeamLinkRetiredError` (`linkRefusal`, deleted),
  `MemberInviteError` (`inviteErrorResponse`, deleted), `RecallWriteError`
  (`recallWriteFailure`, deleted; its status by code moved with the class),
  `ChatArchiveBusyError` and `ChatThreadNotFoundError` (`archiveResponse`'s
  catch). Eleven routes caught a unique violation by hand to say their own
  409; they call `conflictOnUnique(message, fn)` (`@mantle/db`), which
  throws a `ConflictError` with that message (409 by its row): agents,
  ai-workers, files/files, files/folders, heartbeats, keys, model-pools,
  settings/worker-groups, skills, tool-groups, tools.
- **What stays named under the lens.** `POST /api/users` maps two unique
  violations by constraint and answers any other fault with a fixed 500
  sentence of its own ("Could not create the user."), which the one
  answer would turn into the opaque `internal error`; the docs collections
  answer the settings dialog `{ ok: false, message }` (`NOT_YET` above).
  Both keep their catch.
- **The decoded path (L8).** The loader and the gate looked the ceiling up
  by the raw path, so `/api/%61uth/...` got the JSON ceiling where Hono
  routed it to an auth route; both read `c.req.path` now.
- **A wrapped ceiling error (L9).** A handler that caught the ceiling's
  error and threw its own answered the opaque 500; the loader checks
  `bodyWentOver` when the handler throws too, and answers 413.

The body sweep names one more kind: `item-fault`, the formula seed's
`failed` list saying the fixed sentence where it said the database stand-in's
text (6 cells). Every other cell of both sweeps answers as before.

## Rate limits (A10 #8)

### Before

Every route that limited its callers took the limit by hand, in its own
file or in a helper its handler called first: 38 limits, 32 limiter calls
in 26 route files and more in nine helpers (`token-login.ts`,
`owner-sso.ts`, `member-invites.ts`, `app-runner.ts`, `member-space.ts`,
`push/login-routes.ts`, `workspaces.ts`, `workspace-turn.ts`, the key
budgets). Each built its own bucket key and named its max and window
inline, and each answered its own 429: 15 texts, a text body on five
routes, two header spellings, no Retry-After on two (the OAuth client
registration, the user search). A new route had no limit unless someone
remembered one.

### After

- **One table of named limits** (`server/web/lib/route-limits.ts`,
  `RATE_LIMITS`): each limit once, by name, with its bucket (the key
  prefix, byte for byte as on main), whose key it counts (`ip`: the
  caller's address through `clientIpKey`, an IPv6 caller by its /64;
  `login`: the login the caller is; `brain`: one bucket, a failure
  budget), its max and its window, and the narrowings a limit had:
  `members` (an Admin user is not counted: the voice clips, a member's app
  runs and bytes) and `when` (a query it applies to: the bytes of a file,
  `?raw` or a `?thumb` other than 1, and its thumbnail, `?thumb=1`, each a
  budget of its own; the metadata none). The store is
  `server/web/lib/rate-limit.ts`, unchanged (a fixed window per key, in
  memory, `MANTLE_RATE_LIMIT_SCALE` for the test stack).
- **The row names its limits** (`ROUTE_GATES`, the same file; RouteRow
  `rateLimit`, `server/web/lib/auth/route-policy.ts`): each row to its
  limits by name, read into the row by `buildRouteRow`. A HEAD the GET
  handler answers takes its GET's; an /api/v1 alias its base route's (it
  runs that handler; `GET /api/v1/files/:id/download`, which hands the
  bytes handler `?raw=1`, names the bytes limit itself). A row that takes a
  login's limit must read a caller that names one (owner, member, any
  login, chat, a byte route's reader, or a public row's login at the read),
  and a catch-all or a page takes none: the row fails to build otherwise,
  at boot. A test's stand-in rows take none.
- **The gate takes them** (`server/web/server/middleware/gate.ts`,
  `beforeHandler`), in the request slot, once the caller is answered and
  before the handler: first the row's cross-site refusal, then its limits.
  A login's limit counts the login the pipeline answered
  (`answeredLimitLogin`, `server/web/lib/auth/session.ts`: a member's own
  id where a member called an owner route, an Admin user's actor). On a
  public row that reads its login at the read (`POST /api/auth/pair`,
  `POST /api/auth/change-password`) the read takes the login's limit
  (`publicLoginCaller`), where the handler took it after its read: no
  login spends nothing, and over the limit the read throws the one 429
  (`RouteRefusal`). A row with two limits takes both, then the failure
  budgets (`peek`: looked at, not spent; the handler counts each failure,
  `countRateFailure`, the invite routes' failed codes).
- **The cross-site refusal is the row's too** (`crossSite`,
  `refuseCrossSiteAuthPost` in `server/web/lib/auth/preflight.ts`): the
  login-CSRF refusal of the public auth posts came first in their handlers,
  before any limit, so a page on another site could not spend a visitor's
  budget. The gate answers it before the limits now, on the six rows that
  named it (sign in, sign up, invite accept, change password, the contact
  code, and sign-out by its origin), and the handlers no longer call it.
- **One 429** (`rateLimitedResponse`): `{ "error": "Too many requests. Try
again later.", "code": "rate_limited", "retryAfter": N }`, with
  `Retry-After: N` (at least 1) and `Cache-Control: no-store`. The seconds
  are in the body too: a browser on another origin cannot read the header
  unless it is exposed. `code` is the one the workspaces contract already
  names (`rate_limited`); the clients branch on the status. Every limiter
  of the tier answers it: the rows', the budgets the named route files keep
  (below), the API key budgets (`server/web/server/middleware/access-key-gate.ts`),
  a member's turns a minute (`server/web/lib/workspace-turn.ts`) and the member
  stream cap (`GET /api/member/realtime`, Retry-After 30 as before).
- **Retry-After on the daily caps.** The member chat's daily turn cap and
  token budget (`workspace-turn.ts`, a turn and a voice clip or summary)
  are quotas, not limits of the table, and keep their bodies (`reason:
daily_cap` or `token_budget`, which the client reads); they say when to
  come back now too: `Retry-After` to the next midnight UTC
  (`secondsUntilTomorrowUtc`, `server/web/lib/member-daily-cap.ts`).
- **Folded or gone**: `memberWriteGate` (no caller since the member space
  routes went in W5c) and `memberBytesGate` with its file (`member-space.ts`, deleted);
  `inviteRateLimited`, `pushEnrolLimited`, `rateLimited` (preflight.ts),
  the app runner's `tooMany`; the user search's `WsError(429)`.

### What stays named

Budgets that are not a gate on the request stay where they are taken,
each named with its reason:

- in route files (`RATE_LIMIT_ALLOW`, `eslint-rules/route-plumbing.mjs`):
  `POST /api/access-keys` (the password failure budget, taken before the
  check and given back on a right password, and the keys made an hour,
  counted only once the password passed), `POST /api/oauth/authorize` (the
  consent password failure budget; its 429 is the consent page again, a
  page, not the JSON 429), and `/api/mcp` (each MCP caller's own budget, an
  API key's, a peer's or a login's, keyed by the bearer the route resolves
  itself; the per-address limit before it is the row's);
- `server/web/lib/workspace-turn.ts`: a member's 6 turns a minute counts the
  turns QUEUED, not the requests: a retry with the same Idempotency-Key is
  answered from the turn route's own cache and spends nothing, which a
  gate before the handler could not keep;
- `server/web/lib/access-keys.ts` with `server/web/server/middleware/access-key-gate.ts`:
  an API key's budgets (per key, per login, the search's own, and the
  failed-key budgets in their own pool), taken by the key gate for every
  `/api/v1` request a key makes, whatever the row (and by `/api/mcp`);
- not HTTP limits at all: the Telegram pairing attempts
  (`packages/telegram/src/pairing.ts`, a pairing code's own count, answered
  with the pairing refusal shape the client reads), the member stream cap
  (`server/web/lib/member-streams.ts`, a count of open streams, not a rate),
  the app access log's throttle (`packages/content/src/app-access-log.ts`,
  how often a row is written) and the drawing snapshot's failure cooldown
  (`server/web/lib/draw-snapshot.ts`, how often a render is retried);
- other 429s that are not limits: busy (`reason: 'busy'`, the app database
  and the package import: wait and retry), the health check passing on the
  public MCP's own answer (`mcp-status`).

### Rows with no limit

No limit was added to a row that had none (that would change who gets
refused). The rows a caller other than an Admin user reaches with no limit
of their row are named here (`UNLIMITED_NON_OWNER_ROWS`), by how they are
reached, and pinned by `server/web/lib/route-limits.test.ts` (here and in
`server/web/lib/__snapshots__/route-limits-unlimited.txt`): a new one fails
the test, so it is a decision, not an accident. Rows only an Admin user
reaches need none. A HEAD is its GET's; a retired route's 410 stub is left
out. `POST /api/access-keys`, `POST /api/oauth/authorize` and the MCP's
per-caller budget are budgets of their handlers, above.

<!-- UNLIMITED_NON_OWNER_ROWS start -->

```
any logins (27):
  DELETE /api/access-keys/:id
  DELETE /api/grants/:nodeId/:wsId
  DELETE /api/workspaces/:id/resources/:kind/:refId
  DELETE /api/workspaces/:id/users/:loginId
  GET /api/access-keys
  GET /api/grants/:nodeId
  GET /api/grants/:nodeId/preview
  GET /api/shell
  GET /api/v1/whoami
  GET /api/workspaces
  GET /api/workspaces/:id
  GET /api/workspaces/:id/archive-preview
  PATCH /api/grants/:nodeId/:wsId
  PATCH /api/workspaces/:id
  PATCH /api/workspaces/:id/resources/:kind/:refId
  PATCH /api/workspaces/:id/users/:loginId
  POST /api/access-keys
  POST /api/grants/:nodeId
  POST /api/grants/:nodeId/:wsId/hand
  POST /api/grants/:nodeId/:wsId/restore
  POST /api/grants/:nodeId/embeds
  POST /api/grants/move
  POST /api/grants/move/preview
  POST /api/workspaces
  POST /api/workspaces/:id/archive
  POST /api/workspaces/:id/resources
  POST /api/workspaces/:id/users
chat logins (11):
  GET /api/assistant/conversations
  GET /api/assistant/messages
  GET /api/assistant/stream
  GET /api/assistant/thread
  GET /api/assistant/threads
  GET /api/assistant/threads/:id
  POST /api/assistant/read
  POST /api/assistant/threads
  POST /api/assistant/threads/:id/continue
  POST /api/assistant/threads/:id/summarize
  POST /api/assistant/turn
frame (a frame ticket) (2):
  GET /api/apps/:id/frame
  GET /api/member/apps/:id/frame
link (a share token) (2):
  GET /s/:token/bundle/css
  GET /s/:token/frame
member logins (8):
  DELETE /api/member/mcp/clients/:id
  DELETE /api/member/push/subscriptions/:id
  GET /api/member/home
  GET /api/member/mcp
  GET /api/member/push/preferences
  GET /api/member/push/subscriptions
  GET /api/member/realtime
  PUT /api/member/push/preferences
owner rows open to members (97):
  DELETE /api/apps/:id
  DELETE /api/apps/:id/draft
  DELETE /api/draws/:id
  DELETE /api/events/:id
  DELETE /api/files/files/:id
  DELETE /api/files/folders/:id
  DELETE /api/formulas/:id
  DELETE /api/notes/:id
  DELETE /api/pages/:id
  DELETE /api/recall/maps/:id
  DELETE /api/recall/maps/:id/cards/:card
  DELETE /api/tables/:id
  DELETE /api/tasks/:id
  DELETE /api/tree/:kind/folders/:id
  GET /api/apps
  GET /api/apps/:id
  GET /api/draws
  GET /api/draws/:id
  GET /api/draws/:id/svg
  GET /api/events
  GET /api/events/:id
  GET /api/files/files
  GET /api/files/folders
  GET /api/files/folders/:id
  GET /api/formulas
  GET /api/formulas/:id
  GET /api/home
  GET /api/mentions/search
  GET /api/nodes/:id
  GET /api/notes
  GET /api/notes/:id
  GET /api/pages
  GET /api/pages/:id
  GET /api/pages/:id/backlinks
  GET /api/pages/:id/descendant-count
  GET /api/recall/maps
  GET /api/recall/maps/:id
  GET /api/recall/maps/:id/cards/:card
  GET /api/recall/maps/:id/revisions
  GET /api/search
  GET /api/tables
  GET /api/tables/:id
  GET /api/tables/:id/rows
  GET /api/tasks
  GET /api/tasks/:id
  GET /api/tree/:kind
  GET /api/tree/:kind/marks
  GET /api/tree/:kind/search
  GET /api/tree/:kind/tags
  PATCH /api/apps/:id
  PATCH /api/draws/:id
  PATCH /api/events/:id
  PATCH /api/files/files/:id
  PATCH /api/files/folders/:id
  PATCH /api/formulas/:id
  PATCH /api/notes/:id
  PATCH /api/pages/:id
  PATCH /api/recall/maps/:id
  PATCH /api/tables/:id
  PATCH /api/tasks/:id
  PATCH /api/tree/:kind/folders/:id
  POST /api/apps
  POST /api/apps/:id/build
  POST /api/apps/:id/format
  POST /api/apps/:id/publish
  POST /api/draws
  POST /api/draws/:id/commit
  POST /api/draws/:id/discard-draft
  POST /api/events
  POST /api/files/files
  POST /api/files/folders
  POST /api/formulas
  POST /api/formulas/:id/evaluate
  POST /api/notes
  POST /api/pages
  POST /api/pages/:id/commit
  POST /api/pages/:id/discard-draft
  POST /api/pages/:id/move
  POST /api/recall/maps
  POST /api/recall/maps/:id/cards
  POST /api/recall/maps/:id/cards/:card/prompt
  POST /api/recall/maps/:id/cards/reorder
  POST /api/recall/revisions/:id/restore
  POST /api/tables
  POST /api/tables/:id/commit
  POST /api/tables/:id/discard-draft
  POST /api/tables/:id/draft-ops
  POST /api/tasks
  POST /api/tree/:kind/folders
  POST /api/tree/:kind/move
  POST /api/tree/items/:id/opened
  PUT /api/apps/:id/draft
  PUT /api/draws/:id/draft
  PUT /api/pages/:id/draft
  PUT /api/recall/maps/:id/cards/:card
  PUT /api/tables/:id/draft
  PUT /api/tree/items/:id/pin
public (no credential, or its own) (20):
  GET /.well-known/oauth-authorization-server
  GET /.well-known/oauth-protected-resource
  GET /api/appearance
  GET /api/appearance/logo
  GET /api/auth/bootstrap-state
  GET /api/auth/client-code
  GET /api/auth/pair/:id
  GET /api/auth/whoami
  GET /api/federation/node/:id
  GET /api/oauth/authorize
  GET /api/version
  GET /pair
  POST /api/auth/client-code
  POST /api/auth/client-code/verify
  POST /api/auth/client-link
  POST /api/auth/logout
  POST /api/auth/mobile-logout
  POST /api/federation/chunks
  POST /api/federation/query
  POST /api/oauth/authorize
telegram logins (5):
  DELETE /api/telegram/my-chats/:id
  GET /api/telegram/moderated-chats
  GET /api/telegram/my-chats
  POST /api/telegram/chats/:id/block
  POST /api/telegram/chats/:id/unpair
```

<!-- UNLIMITED_NON_OWNER_ROWS end -->

### The proof

`server/web/server/a10-rate-sweep.test.ts` drives every limit main took per
request (its inventory, `SWEEP_CELLS`: 60 cells over 56 rows, each with the credential and query its limit counts) through the
full pipeline with the clock held still: the first 429 and its whole
answer, the window (a second before its end, and at its end), the scope
(another address, another login of the kind, the same login from another
address), the rows that share a bucket (the three token sign-ins, the four
push enrol rows), and the order: what the handler checked before its limit
on main still comes first and spends nothing (a cross-site browser
request, no login, an Admin user where only members count, a query with
no limit), and the invite routes' brain-wide failure caps. 246 probes,
recorded on v0.300.44 before the move
(`server/web/server/__snapshots__/a10-rate-sweep.txt`, written once with
`A10_RATE_SWEEP_RECORD=1`). After the move every probe answers as recorded
or is a named change, probe by probe, in
`server/web/server/__snapshots__/a10-rate-sweep-changes.txt`:

| Kind                        | Probes | What                                                                                                                                                                                                                                     |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one-429                     | 96     | a limit's refusal is the one 429, with the same Retry-After, where the route answered a 429 of its own; the place of the first 429, and every other answer, as on main                                                                   |
| one-429 (Retry-After added) | 8      | the same, where main's 429 said no Retry-After (the user search)                                                                                                                                                                         |
| counted-before-the-route    | 2      | the user search takes its limit before its own checks now (the row's, the gate's): a search the route refuses (an offset that is not a number, the Moderator check) counts toward the login's 60 a minute, where it was taken after them |

A second test holds the table to the inventory, limit by limit (bucket,
scope, max, window, members, failure budget): no row lost a limit or took
another, and no row has one the inventory does not name.

The other sweeps: the A4 guard sweeps
(`server/web/server/__snapshots__/a4-guard-sweep.txt` and
`a4-guard-sweep-more.txt`) run many sign-in cells back to back and so meet
the limits; 65 cells answer the one 429 where they answered the route's
own (the same cells as on main: the count is unchanged), every other cell
byte for byte (checked cell by cell, the numbered answers renumber). The
body and error sweeps start every cell on a new day and meet no limit:
byte for byte.

### The pins

- Scoreboard (`scripts/arch-scoreboard.pins.json`): `routeRateLimitCalls`,
  limiter calls in route files outside the named list, 32 on main, pinned
  at 0; `routeRateLimitAllowed`, the named files, pinned at 3.
  `routePolicyLists` went 16 to 17: `ROUTE_GATES` is the source of two row
  fields, named with its reason in `eslint-rules/no-policy-name-lists.mjs`.
- ESLint (`eslint-rules/route-plumbing.mjs`, `no-route-rate-limits`): a
  limiter call (`rateLimit` and its forms, `rateLimitAccessKey`) in a route
  file outside `RATE_LIMIT_ALLOW` is an error, and so is
  `refuseCrossSiteAuthPost` in any route file (the row's `crossSite`).
  `eslint-rules/arch-lints.test.ts` holds the count at 0 and the named list
  to the files that still take a budget.
- `server/web/lib/route-limits.test.ts`: every key of `ROUTE_GATES` is a
  served row, every named limit some row's, and the list above.
