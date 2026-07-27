/**
 * Env passed to child shells (run_terminal and shell-kind tools). These tools
 * feed stdout/stderr straight back to the model, so a single `env`/`printenv`
 * would otherwise exfiltrate the at-rest encryption key (and every API key) in
 * one call — collapsing the whole encryption story to "don't grant this tool".
 * We drop the crypto/session/db roots by exact name and anything whose name
 * looks secret-shaped, while keeping PATH, HOME, NODE_*, PNPM_*, etc. so
 * git/pnpm/builds still run. An allowlist was rejected — it breaks too many
 * legit toolchains; this denylist closes the exfil path without changing what
 * commands work.
 *
 * Env names are UPPER_SNAKE, so we match secret words as whole `_`-delimited
 * SEGMENTS: this catches S3_ACCESS_KEY / S3_SECRET_KEY / GITHUB_TOKEN / any
 * *_KEY without the substring false-positives a bare /key/ would cause
 * (MONKEY_BUSINESS, KEYCLOAK_URL both stay). */
const SECRET_ENV_EXACT = new Set([
  'MANTLE_MASTER_KEY',
  'MANTLE_MASTER_KEY_NEXT',
  'SESSION_SECRET',
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
]);
const SECRET_ENV_SEGMENT =
  /(^|_)(secret|secrets|token|tokens|password|passwd|passwords|passphrase|credential|credentials|key|keys|apikey|privatekey)(_|$)/i;
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const k of Object.keys(out)) {
    if (SECRET_ENV_EXACT.has(k) || SECRET_ENV_SEGMENT.test(k)) delete out[k];
  }
  return out;
}
