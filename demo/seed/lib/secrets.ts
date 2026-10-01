/**
 * The demo's passwords, for the seed scripts.
 *
 * They are made per checkout by demo/scripts/lib/secrets.sh (a fresh seed
 * creates them in demo/.run/secrets, gitignored) and are never committed. A
 * script reads the environment first, which is what the shell scripts export,
 * and then the file, so a script run by hand still works. There is no default:
 * a password in a public repository is a password everyone has.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRETS_DIR =
  process.env.DEMO_SECRETS_ABS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.run', 'secrets');

function secret(envName: string, fileName: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  try {
    const value = readFileSync(join(SECRETS_DIR, fileName), 'utf8').trim();
    if (value) return value;
  } catch {
    // fall through to the message below
  }
  console.error(
    `✗ ${envName} is not set and ${join(SECRETS_DIR, fileName)} does not exist.\n` +
      '  A fresh demo/scripts/seed.sh makes the demo secrets; a brain seeded before they\n' +
      `  stopped being committed constants needs its old value passed in ${envName}.`,
  );
  process.exit(1);
}

export const ownerPassword = () => secret('DEMO_OWNER_PASSWORD', 'owner-password');
export const memberPassword = () => secret('DEMO_MEMBER_PASSWORD', 'member-password');
