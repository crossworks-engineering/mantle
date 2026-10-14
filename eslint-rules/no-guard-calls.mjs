/**
 * no-guard-calls (workspaces arch plan v2, section 11; A0): from A4 step 3
 * a route handler reads the caller the pipeline answered and calls no guard
 * (getOwnerOr401 and its variants). Count only until the codemod is done.
 * Since A4 step 3b the pin is a ceiling: the codemod takes the calls down
 * batch by batch (docs/actors.md), and a new owner route reads the caller
 * the pipeline answers (ownerCaller()) instead of calling a guard;
 * eslint-rules/arch-lints.test.ts fails when the count goes over the pin. A
 * guard that goes with nothing in its place shows as a live route calling
 * no guard (the scoreboard's liveRoutesWithoutGuard, which may not grow). A4
 * exit: 0, and this becomes a rule.
 *
 * 469 -> 468 (task d78e7bde): PUT and DELETE /api/team-admin/hub-app became
 * 410 stubs (`gone('owner')` runs the same guard from lib/gone.ts), and the
 * new GET /api/home adds one call.
 *
 * 468 -> 439 (A4 step 3b part 1, batch 1, the self rows): 29 getOwnerOr401
 * calls in 23 route files became reads of the caller the pipeline answers.
 *
 * 439 -> 382 (A4 step 3b part 2, batch 2, the content reads): 57 GET
 * handlers' getOwnerOr401 calls in 57 route files became reads.
 *
 * 382 -> 285 (A4 step 3b part 3, batch 3, the content writes): 101 write
 * handlers in 81 route files became reads, 98 of them getOwnerOr401 calls
 * (97 counted: server/web/app/api/apps/[id]/build/route.ts sits under a
 * `build/` folder the counts skipped until A4 step 3b part 4, which counts
 * such a route segment; it reads the caller now, so the pin holds) and the
 * 3 getOwnerOr401WithLogin calls of the app brokers and the frame ticket
 * (not counted here).
 *
 * 285 -> 43 (A4 step 3b part 4, batch 4, the Admin area rows): 243
 * handlers in 172 route files became reads, 242 of them getOwnerOr401
 * calls and POST /api/users/:id/password's getOwnerOr401WithSource (not
 * counted here).
 */
export const GUARD_CALL_PIN = 43;
