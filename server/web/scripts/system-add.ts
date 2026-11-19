/**
 * system:add, the operator's recovery of the System workspace
 * (lib/system-workspace.ts has the rule). Adds one login to Admin (when it
 * is not an Admin user) and to System, as workspace system work. For a
 * brain whose System users are all gone; on any other brain a System user
 * adds people on the System workspace screen.
 *
 * Usage (on the box, in the web container):
 *   pnpm -C server/web system:add --email <address>
 *
 * Numbers only: it prints what it added, never a name or an id.
 *
 * Exit codes: 0 done (or nothing to do) · 1 crash or a bad argument ·
 * 2 refused (no such login, a disabled or archived login, no Admin
 * workspace on this brain). A brain with Admin and no System gets System
 * made first (every Admin user seated).
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { systemAdd } from '../lib/system-workspace';

if (!env('DATABASE_URL')) {
  console.error('system-add: DATABASE_URL must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
let email: string | null = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--email' && args[i + 1] && !args[i + 1]!.startsWith('--')) {
    email = args[++i]!;
  } else {
    console.error(`system-add: unknown argument ${a}`);
    process.exit(1);
  }
}
if (!email) {
  console.error('system-add: --email <address> is required');
  process.exit(1);
}

const WHY = {
  no_login: 'no login with that email on this brain',
  disabled: 'the login is disabled or archived: enable it first',
  no_system: 'this brain has no Admin workspace (run the migrations first)',
} as const;

async function main(): Promise<number> {
  const r = await systemAdd(email!);
  if (!r.ok) {
    console.error(`[system-add] refused: ${WHY[r.reason]}`);
    return 2;
  }
  console.log(
    `[system-add] done: added to Admin ${r.addedToAdmin ? 1 : 0}, ` +
      `added to System ${r.addedToSystem ? 1 : 0}`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch((err) => {
    console.error('[system-add] failed:', errorMessage(err));
    process.exit(1);
  });
