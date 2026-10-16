/**
 * The web process after a first owner whose brain is not on workspaces
 * (arch A7, first-owner.ts): it is never served. Its own file, with no
 * database import: the timer below is a deadline before the process stops,
 * not a loop (eslint-rules/process-entries.test.ts).
 */
import { log } from '@mantle/tracing';
import { unmigratedBrainRefusal } from '../workspaces-migrate';

/** How long the signup's answer has to leave before the process stops. */
const EXIT_AFTER_MS = 500;

/**
 * The web process after a first owner whose brain is not on workspaces:
 * log the boot's refusal and stop, so the restart (the container's restart
 * policy, or the operator) runs the boot's switch again, and the boot
 * refuses to serve while it still fails. A short delay first, so the
 * signup's own answer reaches the client. `exit` is for tests.
 */
export function refuseUnswitchedBrain(
  why: string,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  log('signup').error(unmigratedBrainRefusal(why));
  setTimeout(() => exit(1), EXIT_AFTER_MS);
}
