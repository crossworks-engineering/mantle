import { errorMessage } from '@mantle/std';

/**
 * One chrome read of a shell route (/api/shell, /api/member/shell,
 * /api/client/shell), and what the shell answers when it throws (client
 * logins audit A13). The client learns the ROLE from which shell answers
 * 200, so a failed preferences read or pending count must not fail the whole
 * route: that locks the login out of the app over a badge. The role gate
 * stays first and is never caught: no session, or the wrong role, still
 * answers 401 or 403.
 *
 * The failure is logged with the route and the part, and the shell answers
 * `fallback` for that part only.
 */
export async function shellPart<T, F>(
  route: string,
  part: string,
  read: () => Promise<T>,
  fallback: F,
): Promise<T | F> {
  try {
    return await read();
  } catch (err) {
    console.error(`[${route}] ${part} failed, answering without it: ${errorMessage(err)}`);
    return fallback;
  }
}
