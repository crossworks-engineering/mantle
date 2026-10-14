# Request plumbing: one body reader, one error answer

A10 part 2 (the gateway survey's folds 1 and 2; the survey is a dev-brain
page). Two jobs every route of the HTTP tier did for itself, each folded
behind one gateway, proved by recording every answer before the move and
holding every answer to it after, and pinned so the scattered form cannot
come back. Part of the actor work: [actors.md](actors.md) links here.

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
  there. A handler that swallowed the error still answers 413
  (`bodyWentOver`). Nothing is read until a reader asks. An upload path
  (no ceiling: the multipart uploads, which stream to disk under their own
  caps) gets its request as before.
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

| Kind                                               | Cells | What                                                                                                                                                                           |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| chunked-413                                        | 207   | a chunked body over the ceiling answers 413 `body-too-large` where the route read it in full and answered whatever `{}` gave it (a 400 field message, a 404, a 500)            |
| bad-json-400 (malformed)                           | 200   | `{"a":` answers 400 `{"error":"invalid JSON"}` where the route read `{}` or null and failed later with another message, or refused it with a text of its own (`invalid body`)  |
| bad-json-400 (malformed, accepted as `{}` on main) | 9     | the same, where `{}` passed and the route went on as if no field was sent: the turn cancel, sign-out, the docs collections (3), the embedding settings (3) and the network key |
| bad-json-400 (empty)                               | 2     | `PATCH /api/mcp-settings` and `PATCH /api/team-admin/settings` refuse an empty body with the one text where they said `invalid body`                                           |

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

### Left open

The multipart uploads that use `formData()` (`/api/assistant/turn`'s
attachment, `/api/assistant/transcribe`, `/api/tables/:id/import`,
`/api/profile/photo` and `/logo`) sit on upload paths with no loader
ceiling, as before: `formData()` buffers the whole body before their own
size checks run. A streamed cap per route (its file limit plus the
framing) would close that; it is not in this change.

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

| Kind            | Cells | What                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opaque-500      | 26    | a plain or a database error, whose text the route put in a 400, answers the opaque 500: POST and PATCH of `contacts`, `events`, `journal` (and `journal/:id/resolve`), PATCH `formulas/:id`, PATCH and POST `files/files/:id` and `files/folders/:id`, POST `tables/:id/commit` (each for both faults)                                              |
| domain-by-table | 418   | a domain error answers as the table says where a hand catch gave it another status: the folder errors and the visibility list where a route put their text in a 400 or mapped none (the opaque 500), busy 409 where 14 cells said it in a 400, and the workspace refusal 403 on `POST /api/tables/:id/commit` (it said the refusal's text in a 400) |

Most domain-by-table cells are forced: a route that never meets a
`TreeError` answers one by the table now, where it answered the opaque 500. The 9 body sweep cells that change in fold 2 are the same move seen
from there (`opaque-500 (fold 2)`: the sweep's database stand-in throws a
plain error, whose text was the reply). Every other cell of both sweeps is
byte for byte, and the A4 sweeps are unchanged.

### The pins

- Scoreboard: `routeErrorTextFiles`, route files putting a caught error's
  text in a reply outside the named list, pinned at 0;
  `routeErrorTextAllowed`, the named files, 86 on main, pinned at 72.
- ESLint (`eslint-rules/route-plumbing.mjs`, `no-error-text-replies`): such
  a catch is an error in a route file outside `ERROR_TEXT_ALLOW`.
  `eslint-rules/arch-lints.test.ts` holds the list to the files that still
  do it, so it only shrinks.

### Left open (fold 2 continues)

The 72 named files, each `not yet moved` in `ERROR_TEXT_ALLOW`. The same
recipe for each: find the domain checks its callers hear (a plain `Error`
with a message for a person) and give them `InputError` or
`ConflictError` (or a class of their own with a row); delete the catch;
run both sweeps, name the changes; take the file off the list and lower
the pin. Some may be deliberately public (an AI worker's test routes show
the owner the provider's own error, the dev console shows the upstream's):
those keep their text with a reason of their own in the list. The tool
surface reads the table through `publicErrorMessage`; the tools'
`visibilityRefusal` (`packages/tools`) still words the visibility list for
a model itself.
