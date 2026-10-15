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
 * For the shell, the access keys, /api/v1/whoami and (A4 hand batch B,
 * its login read inside the exit, where its guard ran) /api/auth/whoami,
 * and the chat routes. Since arch A6 round 2 lib/grants.ts and
 * lib/workspaces.ts read in the scope and no longer come through here.
 */
export function inRuleInQuery<R>(body: () => Promise<R>): Promise<R> {
  return asSystem(body, 'rule-in-query');
}
