/**
 * no-guard-calls (workspaces arch plan v2, section 11; A0): from A4 step 3
 * a route handler reads currentCaller() and calls no guard (getOwnerOr401
 * and its variants). Count only for now: until A4 every new route still
 * calls a guard, so the total may grow; eslint-rules/arch-lints.test.ts
 * fails when it drops below the pin (a guard gone with no A4 pipeline to
 * replace it). A4 turns this into a rule and the pin into a ceiling.
 */
export const GUARD_CALL_PIN = 469;
