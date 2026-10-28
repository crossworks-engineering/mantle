import { NET_TIMEOUTS, timeoutSignal } from '@mantle/std';
import { documentsAvailable, gotenbergAuthHeader, gotenbergConfig } from './config';

/** What the engine's GET /health answers: a status per module. */
export type GotenbergHealth = {
  up: boolean | null;
  version: string | null;
  /** Per module ('chromium', 'libreoffice'): 'up' or 'down'. Empty when
   *  the probe did not reach the engine. */
  modules: Record<string, 'up' | 'down'>;
};

/**
 * Probe the documents engine for the dashboard pill and Settings > Services.
 * Never throws.
 *
 *   up: null   the service is off, or GOTENBERG_URL / GOTENBERG_PASSWORD are
 *              unset: a neutral pill, not a red one.
 *   up: false  on, but /health did not answer 200 (starting, crashed, or a
 *              module is down; `modules` says which).
 *   up: true   healthy; `version` from GET /version.
 *
 * /health takes no credential (the engine exempts it, as the compose
 * healthcheck needs); /version does, so it is read with the password and its
 * failure never marks the engine down.
 */
export async function gotenbergHealth(
  timeoutMs: number = NET_TIMEOUTS.localProbe,
): Promise<GotenbergHealth> {
  const cfg = gotenbergConfig();
  if (!cfg || !documentsAvailable()) return { up: null, version: null, modules: {} };
  try {
    const res = await fetch(`${cfg.url}/health`, { signal: timeoutSignal(timeoutMs) });
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      details?: Record<string, { status?: string }>;
    } | null;
    const modules: Record<string, 'up' | 'down'> = {};
    for (const [name, d] of Object.entries(body?.details ?? {})) {
      modules[name] = d?.status === 'up' ? 'up' : 'down';
    }
    const up = res.ok && body?.status === 'up';
    let version: string | null = null;
    try {
      const v = await fetch(`${cfg.url}/version`, {
        headers: { authorization: gotenbergAuthHeader(cfg) },
        signal: timeoutSignal(timeoutMs),
      });
      if (v.ok) version = (await v.text()).trim() || null;
    } catch {
      // the version is decoration: the pill is up or down by /health alone
    }
    return { up, version: version ? `Gotenberg ${version}` : null, modules };
  } catch {
    return { up: false, version: null, modules: {} };
  }
}
