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
import { getOwnerOr401 } from '@/lib/auth';

/** Backup settings + last-run status + dumps on disk for /settings/backups. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = SaveBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const cfg = normalizeBackupConfig({ ...parsed.data, location: parsed.data.location.trim() });
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
