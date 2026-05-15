import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

/**
 * Thin wrapper around Supabase Storage so the rest of the app never imports
 * `@supabase/supabase-js` for file operations. If we ever swap object stores,
 * this is the only file that knows.
 */

const BUCKET = 'mantle';

let _client: SupabaseClient | undefined;
function serviceClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** sha256 → "aa/bb/<full>" content-addressed key. */
export function contentKey(sha256: string): string {
  if (sha256.length !== 64) throw new Error('expected hex sha256');
  return `attachments/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Upload a buffer, deduplicated by sha256. Returns the storage key.
 * If the key already exists, this is a no-op — content-addressed storage
 * means the bytes are already there.
 */
export async function putContent(
  buf: Buffer,
  contentType: string,
): Promise<{ key: string; sha256: string; size: number; deduped: boolean }> {
  const sha256 = hashBuffer(buf);
  const key = contentKey(sha256);
  const sb = serviceClient();
  const { error } = await sb.storage.from(BUCKET).upload(key, buf, {
    contentType,
    upsert: false,
  });
  const deduped = error?.message?.toLowerCase().includes('already exists') ?? false;
  if (error && !deduped) throw error;
  return { key, sha256, size: buf.byteLength, deduped };
}

export async function getSignedUrl(key: string, expiresInSec = 300): Promise<string> {
  const sb = serviceClient();
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(key, expiresInSec);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteContent(key: string): Promise<void> {
  const sb = serviceClient();
  const { error } = await sb.storage.from(BUCKET).remove([key]);
  if (error) throw error;
}
