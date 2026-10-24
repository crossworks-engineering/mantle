import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  ephemeralBackupDirMessage,
  isBackupDirPersistent,
  listBackups,
  loadBackupConfig,
  loadBackupStatus,
  loadProfilePreferences,
  normalizeBackupConfig,
  resolveBackupDir,
  saveBackupConfig,
} from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** Backup settings + last-run status + dumps on disk for /settings/backups. */
export async function GET() {
  const user = ownerCaller();
  const [config, status, prefs] = await Promise.all([
    loadBackupConfig(user.id),
    loadBackupStatus(user.id),
    loadProfilePreferences(user.id),
  ]);
  const dumps = await listBackups(config);
  return NextResponse.json({
    config,
    status,
    dumps,
    resolvedDir: resolveBackupDir(config),
    timezone: prefs.timezone,
  });
}

const SaveBody = z.object({
  enabled: z.boolean(),
  frequency: z.string(),
  hour: z.number(),
  keep: z.number(),
  location: z.string(),
});

/** Persist the backup schedule config (normalized engine-side, same as the
 *  events worker uses). */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, SaveBody);
  const cfg = normalizeBackupConfig({ ...body, location: body.location.trim() });
  // Reject an ephemeral location at SAVE time (not at 2am when the scheduled run
  // fails): a custom folder outside the persistent bind-mounts lands in the
  // container's overlay and every dump is lost on the next recreate. No-op on
  // dev / native node — only enforced inside a container.
  const dir = resolveBackupDir(cfg);
  if (!isBackupDirPersistent(dir)) {
    return NextResponse.json({ error: ephemeralBackupDirMessage(dir) }, { status: 400 });
  }
  await saveBackupConfig(user.id, cfg);
  return NextResponse.json({ ok: true });
}
