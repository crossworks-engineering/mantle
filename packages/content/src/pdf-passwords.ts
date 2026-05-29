/**
 * PDF password vault. A short list of passwords (typically an ID/account
 * fragment) the extractor tries against encrypted PDF email attachments. Sealed
 * AES-256-GCM at rest (AAD = row id), same as api_keys — the password is an ID
 * fragment, so PII even if low-stakes. See the extractor's `encrypted_pdf` path
 * and @mantle/files `extractPdfTextWithPassword`.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, pdfPasswords, type PdfPassword } from '@mantle/db';
import { open, seal } from '@mantle/crypto';

/** Secret-free view for the settings UI. */
export type PdfPasswordRow = {
  id: string;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function rowOf(p: PdfPassword): PdfPasswordRow {
  return {
    id: p.id,
    label: p.label,
    lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function listPdfPasswords(ownerId: string): Promise<PdfPasswordRow[]> {
  const rows = await db
    .select()
    .from(pdfPasswords)
    .where(eq(pdfPasswords.ownerId, ownerId))
    .orderBy(desc(pdfPasswords.createdAt));
  return rows.map(rowOf);
}

export async function createPdfPassword(
  ownerId: string,
  input: { label?: string; password: string },
): Promise<PdfPasswordRow> {
  const password = input.password.trim();
  if (!password) throw new Error('password required');
  // Allocate id up-front so the seal AAD (= row id) is known before encrypt.
  const id = crypto.randomUUID();
  const { ciphertext, keyVersion } = seal(password, id);
  const [row] = await db
    .insert(pdfPasswords)
    .values({
      id,
      ownerId,
      label: (input.label ?? '').trim().slice(0, 120),
      passwordEnc: ciphertext,
      keyVersion,
    })
    .returning();
  if (!row) throw new Error('createPdfPassword: insert returned no row');
  return rowOf(row);
}

export async function deletePdfPassword(ownerId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(pdfPasswords)
    .where(and(eq(pdfPasswords.id, id), eq(pdfPasswords.ownerId, ownerId)))
    .returning({ id: pdfPasswords.id });
  return res.length > 0;
}

/**
 * Worker-facing: the owner's PDF passwords in plaintext, most-recently-useful
 * first, so the extractor tries the likely winners before the rest. Decrypts
 * each via @mantle/crypto. Owner-scoped.
 */
export async function getPdfPasswordCandidates(
  ownerId: string,
): Promise<Array<{ id: string; password: string }>> {
  const rows = await db
    .select()
    .from(pdfPasswords)
    .where(eq(pdfPasswords.ownerId, ownerId))
    .orderBy(desc(pdfPasswords.lastUsedAt), desc(pdfPasswords.createdAt));
  const out: Array<{ id: string; password: string }> = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, password: open(r.passwordEnc, r.id) });
    } catch {
      // undecryptable (KEK rotated / corrupt) — skip; the others still apply.
    }
  }
  return out;
}

/** Mark a password as having just unlocked a PDF (drives ordering + UI). */
export async function markPdfPasswordUsed(id: string): Promise<void> {
  await db
    .update(pdfPasswords)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(pdfPasswords.id, id));
}
