import { asSystem } from '@mantle/db';

/**
 * Run the body of a route of the any-login libraries whose rule is in its
 * own SQL on the system pool: it leaves the request scope the login's
 * answer entered, by name (asSystem 'rule-in-query',
 * AS_SYSTEM_TURN_REASONS). The handler reads the login the pipeline
 * answered first, outside the exit, and runs only its body inside, so the
 * exit stays narrow:
 *
 *     const login = anyLoginCaller();
 *     return inRuleInQuery(() => handle(login));
 *
 * For the shell, the access keys, /api/v1/whoami, /api/auth/whoami (its
 * login read inside the exit) and the chat routes. lib/grants.ts and
 * lib/workspaces.ts read in the scope and do not come through here.
 */
export function inRuleInQuery<R>(body: () => Promise<R>): Promise<R> {
  return asSystem(body, 'rule-in-query');
}
