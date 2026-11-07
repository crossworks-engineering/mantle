/**
 * The sandboxd HTTP client and the exports-folder plumbing every
 * sandbox tool goes through.
 */

import { autoFiledSourcePath, ensureAutoFiledFolder } from '@mantle/files';
import { env, serviceEnabled } from '@mantle/config';
import { callerScope } from '../admin-gate';

/* ── whose sandbox ───────────────────────────────────────────────────── */

/** The refusal of a sandbox another login made. */
export const NOT_YOUR_SANDBOX_ERROR =
  'This sandbox was made by another login: only the login that made it, or the brain owner, works in it. Make your own with sandbox_create.';

/** The refusal of a folder mount by a login other than the brain owner. */
export const MOUNT_OWNER_ONLY_ERROR =
  "Mounting a Files folder into a sandbox is for the brain owner's login only: the sandbox would see every file in it. Create the sandbox without inbox_folder_id and copy the files in with sandbox_import.";

/** The login the current call serves in a workspace scope, or undefined
 *  outside one (system work: the surface rules decide). Null: a scope that
 *  names no login. */
export function sandboxCaller(): string | null | undefined {
  const scope = callerScope();
  return scope ? scope.loginId : undefined;
}

/**
 * Why the current caller may not work in sandbox `row`, or null: in a
 * workspace scope the login that made it and the brain owner
 * (the anchor login, `ownerId`) only; a row with no maker is the brain
 * owner's. Outside a workspace scope: null.
 */
export function sandboxRefusal(row: { createdBy?: string | null }, ownerId: string): string | null {
  const login = sandboxCaller();
  if (login === undefined || login === ownerId) return null;
  return login !== null && row.createdBy === login ? null : NOT_YOUR_SANDBOX_ERROR;
}

export const DEFAULT_TIMEOUT_S = 120;

export const MAX_TIMEOUT_S = 1800;

/* ── sandboxd client ──────────────────────────────────────────────────── */

const NOT_ENABLED =
  'sandboxes are not enabled on this box (the `sandboxes` service is switched off). ' +
  'An admin can switch Sandboxes on in Settings > Services; every sandbox and its ' +
  'files are kept while it is off. For server-side commands use `run_terminal`.';

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
