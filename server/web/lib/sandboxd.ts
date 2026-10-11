import { env, serviceEnabled } from '@mantle/config';
import { getSandboxByRef } from '@mantle/content';
import { brainOnWorkspacesNow, type Sandbox } from '@mantle/db';
/**
 * Server-side sandboxd client for the Sandboxes UI surface — the web tier's
 * sibling of the tool layer's `sandboxd()` helper (packages/tools/src/
 * builtins-sandbox.ts). Same posture: bearer auth from env, and NEVER throw on
 * network failure — the supervisor being down or absent (a box that hasn't
 * opted into the `sandboxes` compose profile) degrades to null/false so the
 * surface renders DB rows as-is instead of 500ing.
 */

export type SandboxdLiveSandbox = {
  id?: string;
  ownerId?: string;
  containerId?: string;
  state?: string;
  status?: string;
};

export type SandboxdList = {
  sandboxes: SandboxdLiveSandbox[];
  disk: { usedBytes: number | null; budgetBytes: number } | null;
};

/** Is the feature switched on for this box? The `sandboxes` compose profile
 *  is active AND the URL and token are set (@mantle/config services: the
 *  token alone stays after a disable, and is pre-provisioned on every box). */
export function sandboxdEnabled(): boolean {
  return serviceEnabled('sandboxes');
}

async function call(method: string, path: string): Promise<Record<string, unknown> | null> {
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
  if (!base || !token || !sandboxdEnabled()) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Live container list + disk usage, or null when sandboxd is unreachable. */
export async function sandboxdList(): Promise<SandboxdList | null> {
  const data = await call('GET', '/sandboxes');
  if (!data) return null;
  const disk = data.disk as SandboxdList['disk'] | undefined;
  return {
    sandboxes: Array.isArray(data.sandboxes) ? (data.sandboxes as SandboxdLiveSandbox[]) : [],
    disk: disk && typeof disk === 'object' ? disk : null,
  };
}

export type SandboxdHealth = {
  /** null = feature not enabled on this box (profile off) — the muted-pill
   *  resting state, mirroring the tailnet convention. */
  up: boolean | null;
  total: number | null;
  running: number | null;
  disk: SandboxdList['disk'];
};

/** Health probe for the dashboard. Never throws; `up: null` when the
 *  `sandboxes` profile isn't enabled, `up: false` when it is but sandboxd
 *  doesn't answer. */
export async function sandboxdHealth(): Promise<SandboxdHealth> {
  if (!sandboxdEnabled()) return { up: null, total: null, running: null, disk: null };
  const list = await sandboxdList();
  if (!list) return { up: false, total: null, running: null, disk: null };
  return {
    up: true,
    total: list.sandboxes.length,
    running: list.sandboxes.filter((s) => s.state === 'running').length,
    disk: list.disk,
  };
}

/** Stop a sandbox's container. False on any failure (sandboxd down, no container). */
export async function sandboxdStop(id: string): Promise<boolean> {
  return (await call('POST', `/sandboxes/${id}/stop`)) !== null;
}

/** Remove a sandbox's container; `purge` also deletes its /files host dir. */
export async function sandboxdRm(id: string, purge: boolean): Promise<boolean> {
  return (await call('DELETE', `/sandboxes/${id}${purge ? '?purge=1' : ''}`)) !== null;
}

/**
 * Sandbox `ref` for the signed-in login, or null (the route answers 404):
 * the sandbox tools' maker rule (W7a fix round 3; packages/tools
 * sandbox/common.ts sandboxRefusal) on the Sandboxes routes. The brain owner
 * (the anchor login, whose id is the owner id) works in every sandbox; any
 * other login only in the ones it made (sandboxes.created_by; a row with no
 * maker is the brain owner's), under the rollback switch too (W7 integration
 * fix 2, M6: it restores only the read path). A brain not on workspaces: as
 * before, any Admin login.
 */
export async function sandboxForLogin(
  user: { id: string; actor: { id: string } },
  ref: string,
): Promise<Sandbox | null> {
  const row = await getSandboxByRef(user.id, ref);
  if (!row) return null;
  const login = user.actor.id;
  if (login === user.id || row.createdBy === login) return row;
  if (!(await brainOnWorkspacesNow())) return row;
  return null;
}
