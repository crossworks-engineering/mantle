import { env, serviceEnabled } from '@mantle/config';

/**
 * Where the documents engine (Gotenberg) is, and the credential it asks for.
 *
 * The engine runs as the `gotenberg` compose service behind the `documents`
 * profile (Settings > Services). Compose hands every app container
 * GOTENBERG_URL (the service name) and GOTENBERG_PASSWORD (the basic-auth
 * password install.sh or the updater generated); a dev process sets both in
 * .env.local against the dev compose's loopback port. Neither means the
 * engine runs: @mantle/config `serviceEnabled('documents')` reads the live
 * profile, and that is the one gate every caller asks (documentsAvailable).
 */
export const GOTENBERG_USERNAME = 'mantle';

export type GotenbergConfig = {
  /** The engine's origin, no trailing slash. */
  url: string;
  /** The basic-auth password; never logged, never sent anywhere else. */
  password: string;
};

/** The engine's address and password, or null when either is unset. */
export function gotenbergConfig(): GotenbergConfig | null {
  const url = env('GOTENBERG_URL');
  const password = env('GOTENBERG_PASSWORD');
  if (!url || !password) return null;
  return { url: url.replace(/\/+$/, ''), password };
}

/** The documents service is switched on for this box and the engine is
 *  wired: the gate for every conversion. A service that is on but not
 *  answering is still "available"; its calls fail with their own error. */
export function documentsAvailable(): boolean {
  return serviceEnabled('documents') && gotenbergConfig() !== null;
}

/** The Authorization header the engine requires (API_ENABLE_BASIC_AUTH). */
export function gotenbergAuthHeader(cfg: GotenbergConfig): string {
  return `Basic ${Buffer.from(`${GOTENBERG_USERNAME}:${cfg.password}`, 'utf8').toString('base64')}`;
}
