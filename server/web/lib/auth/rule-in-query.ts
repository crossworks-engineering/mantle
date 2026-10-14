import { asSystem } from '@mantle/db';

/**
 * Run the body of a route of the any-login libraries whose rule is in its
 * own SQL on the system pool (workspaces W6a): it leaves the request scope
 * the login's answer entered, by name (asSystem 'rule-in-query',
 * AS_SYSTEM_TURN_REASONS). Since A4 hand batch A the handler reads the
 * login the pipeline answered first, outside the exit, and runs only its
 * body inside (the exit as narrow as before):
 *
 *     const login = loginCaller();
 *     return inRuleInQuery(() => handle(login));
 *
 * For the shell, the access keys and /api/v1/whoami; lib/workspaces.ts and
 * lib/grants.ts do the same in wsRoute and grantsRoute.
 */
export function inRuleInQuery<R>(body: () => Promise<R>): Promise<R> {
  return asSystem(body, 'rule-in-query');
}

/**
 * The whole handler inside the exit, its guard included: for GET
 * /api/auth/whoami, a public row that reads the login with its own guard
 * (the hand batch's part B).
 */
export function ruleInQuery<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => inRuleInQuery(() => handler(...args));
}
