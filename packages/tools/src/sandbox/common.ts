/**
 * The sandboxd HTTP client and the exports-folder plumbing every
 * sandbox tool goes through.
 *
 * Split out of builtins-sandbox.ts; bodies moved verbatim.
 */

import { autoFiledSourcePath, ensureAutoFiledFolder } from '@mantle/files';
import { env, serviceEnabled } from '@mantle/config';

export const DEFAULT_TIMEOUT_S = 120;

export const MAX_TIMEOUT_S = 1800;

/* ── sandboxd client ──────────────────────────────────────────────────── */

const NOT_ENABLED =
  'sandboxes are not enabled on this box — the sandboxd service runs behind the `sandboxes` ' +
  'compose profile. Ask the owner to enable it; for server-side commands use `run_terminal`.';

export async function sandboxd(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
  if (!base || !token || !serviceEnabled('sandboxes')) return { ok: false, error: NOT_ENABLED };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: NOT_ENABLED };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : `sandboxd → ${res.status}`,
    };
  }
  return { ok: true, data };
}

/**
 * Binary sibling of `sandboxd()` for the IMPORT stream — bytes up, JSON back.
 * The file is the body, so the destination path rides the query string.
 */
export async function sandboxdUpload(
  path: string,
  bytes: Buffer,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
  if (!base || !token || !serviceEnabled('sandboxes')) return { ok: false, error: NOT_ENABLED };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
  } catch {
    return { ok: false, error: NOT_ENABLED };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : `sandboxd → ${res.status}`,
    };
  }
  return { ok: true, data };
}

/** Binary sibling of `sandboxd()` for the export stream. */
export async function sandboxdBinary(
  path: string,
  body: unknown,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const base = env('SANDBOXD_URL');
  const token = env('SANDBOXD_TOKEN');
  if (!base || !token || !serviceEnabled('sandboxes')) return { ok: false, error: NOT_ENABLED };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: NOT_ENABLED };
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : `sandboxd → ${res.status}`,
    };
  }
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Where sandbox exports land: Auto-filed's Sandbox exports folder. */
export const EXPORTS_FOLDER_PATH = autoFiledSourcePath('sandbox-exports');

/** Make the sandbox exports folder if it is missing. */
export async function ensureExportsFolder(ownerId: string): Promise<void> {
  await ensureAutoFiledFolder(ownerId, 'sandbox-exports');
}

/* ── tools ────────────────────────────────────────────────────────────── */
