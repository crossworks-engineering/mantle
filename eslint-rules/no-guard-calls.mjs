/**
 * no-guard-calls (workspaces arch plan v2, section 11; A0): from A4 step 3
 * a route handler reads currentCaller() and calls no guard (getOwnerOr401
 * and its variants). Count only for now: the total is pinned, and
 * eslint-rules/arch-lints.test.ts fails when it goes up. A4 makes it a
 * rule.
 */
export const GUARD_CALL_PIN = 469;
