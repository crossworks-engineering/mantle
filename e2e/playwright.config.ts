import { defineConfig } from '@playwright/test';
import { CLIENT_URL, SERVER_URL } from './lib/env';

/**
 * Two projects, one spec set:
 *
 *   same-origin — CLIENT_URL === SERVER_URL (the monolith / the server app's
 *                 own surfaces). This project runs in CI on every PR.
 *   split       — CLIENT_URL is a separate origin (the client/web app). This
 *                 project is the gate for the Phase 4+ topology and is skipped
 *                 automatically while the two URLs are identical.
 *
 * The suite drives an EXTERNAL stack (no webServer here) — boot one with
 * e2e/scripts/run-local.sh or point E2E_SERVER_URL/E2E_CLIENT_URL at a box.
 */
const isSplitConfigured = CLIENT_URL !== SERVER_URL;

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: false, // small suite; keeps SSE/asset specs from racing bootstrap
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  timeout: 60_000,
  use: {
    baseURL: CLIENT_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'same-origin' }, ...(isSplitConfigured ? [{ name: 'split' }] : [])],
});
