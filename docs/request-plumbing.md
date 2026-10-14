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

The named changes (418 of 2178 cells; every other cell byte for byte):

| Kind                                               | Cells | What                                                                                                                                                                           |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| chunked-413                                        | 207   | a chunked body over the ceiling answers 413 `body-too-large` where the route read it in full and answered whatever `{}` gave it (a 400 field message, a 404, a 500)            |
| bad-json-400 (malformed)                           | 200   | `{"a":` answers 400 `{"error":"invalid JSON"}` where the route read `{}` or null and failed later with another message, or refused it with a text of its own (`invalid body`)  |
| bad-json-400 (malformed, accepted as `{}` on main) | 9     | the same, where `{}` passed and the route went on as if no field was sent: the turn cancel, sign-out, the docs collections (3), the embedding settings (3) and the network key |
| bad-json-400 (empty)                               | 2     | `PATCH /api/mcp-settings` and `PATCH /api/team-admin/settings` refuse an empty body with the one text where they said `invalid body`                                           |

Every valid, NUL and array cell is unchanged. The A4 sweeps
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
