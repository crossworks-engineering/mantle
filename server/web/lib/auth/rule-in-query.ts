import { asSystem } from '@mantle/db';

/**
 * A route of the any-login libraries whose rule is in its own SQL on the
 * system pool (workspaces W6a): the session guard still enters the login's
 * scope for the request (the route sweep sees it), and this handler leaves
 * it by name (asSystem 'rule-in-query', AS_SYSTEM_TURN_REASONS). For the
 * shell, access keys and whoami; lib/workspaces.ts and lib/grants.ts do the
 * same in wsRoute and grantsRoute.
 */
export function ruleInQuery<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => asSystem(() => handler(...args), 'rule-in-query');
}
