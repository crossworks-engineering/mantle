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
 */
export const GUARD_CALL_PIN = 439;
