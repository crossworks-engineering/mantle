/**
 * Discover the drives a connected account can sync: its OneDrive plus the
 * document libraries of the SharePoint sites it follows. Upserts them into
 * `ms_drives` *disabled* — the user opts specific drives in (the drive-level
 * analogue of the email contact-gate). Re-running refreshes metadata without
 * touching `enabled`/`delta_link`, so a re-discover never disrupts an active
 * sync.
 */
import { createHash } from 'node:crypto';
import { db, msDrives, type MsAccount } from '@mantle/db';
import { dashToLtree, slugifyFolder } from '@mantle/files';
import { graphGet, graphGetAll } from '../client';
import type { GraphDrive, GraphSite } from './types';

interface FoundDrive {
  driveId: string;
  driveType: string;
  name: string;
  siteName: string | null;
  webUrl: string | null;
}

/** Stable single ltree label for a drive: slug of its name + a short hash of
 *  the drive id (so two libraries named "Documents" don't collide). */
function driveBranchLabel(driveId: string, name: string): string {
  const slug = slugifyFolder(name);
  const base = (slug ? dashToLtree(slug) : '') || 'drive';
  const hash = createHash('sha256').update(driveId).digest('hex').slice(0, 4);
  return `${base}_${hash}`;
}

/** Enumerate + upsert this account's drives. Returns how many were found. */
export async function discoverDrives(account: MsAccount): Promise<number> {
  const found: FoundDrive[] = [];

  // OneDrive (the user's own drive).
  try {
    const me = await graphGet<GraphDrive>(account.userId, account.id, '/me/drive');
    if (me?.id) {
      found.push({
        driveId: me.id,
        driveType: me.driveType ?? 'personal',
        name: me.name ?? 'OneDrive',
        siteName: null,
        webUrl: me.webUrl ?? null,
      });
    }
  } catch {
    // OneDrive may be unprovisioned for some accounts — non-fatal.
  }

  // SharePoint document libraries of followed sites.
  try {
    const sites = await graphGetAll<GraphSite>(account.userId, account.id, '/me/followedSites');
    for (const site of sites.items) {
      try {
        const drives = await graphGetAll<GraphDrive>(account.userId, account.id, `/sites/${site.id}/drives`);
        for (const d of drives.items) {
          found.push({
            driveId: d.id,
            driveType: d.driveType ?? 'documentLibrary',
            name: d.name ?? 'Documents',
            siteName: site.displayName ?? site.name ?? null,
            webUrl: d.webUrl ?? null,
          });
        }
      } catch {
        // Skip a site we can't enumerate.
      }
    }
  } catch {
    // No followed sites / insufficient grant — OneDrive-only is still useful.
  }

  for (const f of found) {
    await db
      .insert(msDrives)
      .values({
        accountId: account.id,
        driveId: f.driveId,
        driveType: f.driveType,
        name: f.name,
        siteName: f.siteName,
        webUrl: f.webUrl,
        branchLabel: driveBranchLabel(f.driveId, f.name),
      })
      .onConflictDoUpdate({
        target: [msDrives.accountId, msDrives.driveId],
        // Refresh display metadata only — never reset enabled/delta_link/branchLabel.
        set: { name: f.name, siteName: f.siteName, webUrl: f.webUrl, updatedAt: new Date() },
      });
  }

  return found.length;
}
