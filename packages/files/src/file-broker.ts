/**
 * The files store's object bytes (docs/store-brokers.md): the ONLY importer, for file bytes, of the object
 * store's write API (@mantle/storage/write; the store-brokers lint pins
 * it). An email attachment's bytes and a OneDrive or SharePoint file's are
 * stored here first, under their content address, then the row that names
 * them goes in: the object is the stage, the row's INSERT the flip. A row
 * that never lands leaves an object nothing names; objects are shared by
 * every row with the same bytes (an attachment, a drive file, an app
 * bundle), so the sweep never removes one.
 *
 * The files tree's disk bytes are the files ops' (ops/files.ts, folders.ts,
 * move-copy.ts, through disk.ts): there the disk path IS the row, so the
 * disk follows the row inside its flip (store-broker.ts flipThenPlace).
 */
import { putContent } from '@mantle/storage/write';

/** Store `bytes` under their content address, before the row that names
 *  them: returns the key the row records. Never inside a transaction (a
 *  network write). */
export async function stageFileObject(bytes: Buffer, mimeType: string): Promise<{ key: string }> {
  const { key } = await putContent(bytes, mimeType);
  return { key };
}
