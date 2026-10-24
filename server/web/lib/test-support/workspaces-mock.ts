/**
 * The warm-up of a test file's mock of lib/workspaces (S9 part 3 round 2,
 * the area fold audit's L3). Test support: nothing in the app imports it.
 *
 * The gate's area read imports lib/workspaces on its first use
 * (session.ts loginHoldsArea). A test file that mocks that module with an
 * async factory (`vi.mock(..., async (importOriginal) => ...)`) has its
 * factory run on that first import, and vitest's mocker keeps one call
 * stack for a factory in flight: two first imports at once (a test that
 * timed out under load still sending requests beside the next test) can
 * hand the second one the real module. The real requireArea then reads
 * the test's stubbed database and answers no, a 403 'area' no test asked
 * for (part 2 round 2: the device token cell on the workstation; main the
 * same when its tests time out).
 *
 * Call it in a beforeAll, before any request: the import here runs the
 * factory alone, and every later import is handed its cached answer. A
 * file that does not mock the module gets the real one, imported once.
 *
 * session.ts first, and outside the factory: vitest hands a module's
 * dynamic imports the import chain the module was evaluated in, and a
 * chain that holds the factory in flight is answered the real module (the
 * factory's own importOriginal). Were the area module imported first, its
 * factory would evaluate session.ts inside it, and every later area read
 * would get the real requireArea.
 */
export async function warmWorkspacesMock(): Promise<void> {
  await import('../auth/session');
  await import('../workspaces');
}
