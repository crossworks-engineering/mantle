/** Minimal typed shapes for the Graph drive endpoints M1 touches. Only the
 *  fields we read — Graph returns far more. */

export interface GraphDrive {
  id: string;
  /** `personal` | `business` | `documentLibrary` | … */
  driveType?: string;
  name?: string;
  webUrl?: string;
}

export interface GraphSite {
  id: string;
  displayName?: string;
  name?: string;
  webUrl?: string;
}

export interface DriveItem {
  id: string;
  name?: string;
  eTag?: string;
  cTag?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  /** Present on the drive root — skip it. */
  root?: Record<string, unknown>;
  /** Present on folders — skipped in the flat v1 layout. */
  folder?: { childCount?: number };
  /** Present on files; carries the mime type. */
  file?: { mimeType?: string; hashes?: { sha256Hash?: string; quickXorHash?: string } };
  /** Present on tombstones in a delta response. */
  deleted?: { state?: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
  /** Pre-authenticated short-lived download URL (no auth header needed). */
  '@microsoft.graph.downloadUrl'?: string;
}
