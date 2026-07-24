/**
 * Seed a dedicated "coder" agent — a power-user operator with FULL terminal
 * access (run_terminal) + file/search tools, on a smart model (Opus 4.7).
 *
 * Reached via Saskia delegation ("ask the coder to restart the web server")
 * — the manifest also adds `coder` to the responder's memory_config.delegate_to
 * so that path works immediately. You can also bump its role/priority to talk
 * to it directly on /assistant.
 *
 * Thin wrapper: the agent definition (prompt, tools, the mantle-ops skill, and
 * delegation wiring) now lives in the system manifest. This script just applies
 * it.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:coder
 *
 * SAFETY: the terminal tool is unrestricted by design. The manifest grants it
 * ONLY to this dedicated agent, NOT to the responder/assistant that ingest
 * untrusted email/Telegram — keep it that way (prompt-injection footgun
 * otherwise).
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedCoderAgent(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['coder'], mode: 'overwrite' });
  console.log('[coder] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedCoderAgent(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
