/**
 * The sandboxd HTTP client and the exports-folder plumbing every
 * sandbox tool goes through.
 *
 * Split out of builtins-sandbox.ts; bodies moved verbatim.
 */

import { createFolder, dashToLtree, ensureFilesRootBranch, folderByPath } from '@mantle/files';
import { env } from '@mantle/config';

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
  if (!base || !token) return { ok: false, error: NOT_ENABLED };
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
  if (!base || !token) return { ok: false, error: NOT_ENABLED };
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
  if (!base || !token) return { ok: false, error: NOT_ENABLED };
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

const EXPORTS_FOLDER_SLUG = 'sandbox-exports';

export const EXPORTS_FOLDER_PATH = `files.${dashToLtree(EXPORTS_FOLDER_SLUG)}`;

/** Lazy-create `files/sandbox-exports`, tolerating the concurrent-create race
 *  the same way the api-docs folder does. */
export async function ensureExportsFolder(ownerId: string): Promise<void> {
  await ensureFilesRootBranch(ownerId);
  const existing = await folderByPath({ ownerId, path: EXPORTS_FOLDER_PATH });
  if (existing) return;
  try {
    await createFolder({
      ownerId,
      parentPath: 'files',
      slug: EXPORTS_FOLDER_SLUG,
      description:
        'Work exported from CLI sandboxes (sandbox_export): tar.gz snapshots of /files paths, one per export.',
    });
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
  }
}

/* ── tools ────────────────────────────────────────────────────────────── */
