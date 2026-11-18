/**
 * The Sync sidecar's admin routes (Sync service plan M3), JSON, from the
 * brain only (SYNC_TOKEN): the brain's sync_* tools (an admin's agent over
 * MCP, decision 9) and its sign-in routes call them. The same actions as
 * the screens (accounts.ts).
 *
 *   POST /admin/status              every account and drive, with status
 *   POST /admin/mailbox             add or edit a mailbox
 *   POST /admin/feed                add or edit a calendar feed
 *   POST /admin/microsoft/app       set the Microsoft app
 *   POST /admin/microsoft/mail      an account's Outlook mail on or off
 *   POST /admin/microsoft/drives    look for an account's drives again
 *   POST /admin/drive               a drive on or off, its selections
 *   POST /admin/drive/browse        one folder of a drive
 *   POST /admin/remove              remove a mailbox, feed or Microsoft account
 *   POST /admin/run                 sync one now
 *   POST /oauth/start               start a Microsoft sign-in
 *   POST /oauth/callback            finish one (the callback's query)
 */
import { isUuid } from '@mantle/std';
import {
  AccountError,
  overview,
  refreshDrives,
  removeAccount,
  runNow,
  saveFeed,
  saveMailbox,
  setDrive,
  setOutlookMail,
  type AccountDeps,
  type MailboxInput,
} from './accounts';
import {
  appView,
  browseDrive,
  finishSignIn,
  GraphError,
  MsAuthError,
  saveApp,
  startSignIn,
} from './microsoft';
import type { DriveSelection } from './state';

export type AdminReply = { status: number; body: Record<string, unknown> };

type Body = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const idOf = (v: unknown): string | null => {
  const s = str(v);
  return s && isUuid(s) ? s : null;
};

const ok = (body: Record<string, unknown>): AdminReply => ({ status: 200, body });
const bad = (error: string): AdminReply => ({ status: 400, body: { error } });

/** The answer for one admin route. */
export async function adminReply(path: string, b: Body, deps: AccountDeps): Promise<AdminReply> {
  try {
    switch (path) {
      case '/admin/status':
        return ok(await overview(deps));
      case '/admin/mailbox': {
        const id = b.id === undefined || b.id === null ? null : idOf(b.id);
        if (b.id && !id) return bad('No such mailbox.');
        const input: MailboxInput = {
          address: str(b.address) ?? '',
          displayName: str(b.displayName) ?? null,
          password: str(b.password),
          imapHost: str(b.imapHost) ?? '',
          imapPort: (b.imapPort as number | string) ?? 993,
          imapSecure: bool(b.imapSecure) ?? true,
          smtpHost: str(b.smtpHost) ?? null,
          smtpPort: (b.smtpPort as number | string | null) ?? null,
          smtpSecure: bool(b.smtpSecure) ?? true,
          firstScanDays: (b.firstScanDays as number | string | null) ?? 365,
          enabled: bool(b.enabled) ?? true,
        };
        const a = await saveMailbox(deps, id, input);
        return ok({ id: a.id, address: a.address, enabled: a.enabled, sends: !!a.smtp });
      }
      case '/admin/feed': {
        const id = b.id === undefined || b.id === null ? null : idOf(b.id);
        if (b.id && !id) return bad('No such feed.');
        const f = await saveFeed(deps, id, {
          name: str(b.name) ?? '',
          url: str(b.url) ?? null,
          enabled: bool(b.enabled) ?? true,
        });
        return ok({ id: f.id, name: f.name, enabled: f.enabled });
      }
      case '/admin/microsoft/app': {
        const app = await saveApp(deps.state, {
          clientId: str(b.clientId) ?? '',
          clientSecret: str(b.clientSecret),
          tenant: str(b.tenant),
          redirectUri: str(b.redirectUri) ?? '',
        });
        return ok({ app: appView(app) });
      }
      case '/admin/microsoft/mail': {
        const id = idOf(b.accountId);
        const on = bool(b.on);
        if (!id || on === undefined) return bad('Name the account and on or off.');
        const a = await setOutlookMail(deps, id, on);
        return ok({ id: a.id, upn: a.upn, mail: a.mail });
      }
      case '/admin/microsoft/drives': {
        const id = idOf(b.accountId);
        if (!id) return bad('No such Microsoft account.');
        const drives = await refreshDrives(deps, id);
        return ok({
          drives: drives.map((d) => ({
            id: d.id,
            name: d.name,
            siteName: d.siteName,
            enabled: d.enabled,
          })),
        });
      }
      case '/admin/drive': {
        const id = idOf(b.driveId);
        if (!id) return bad('No such drive.');
        const selections = Array.isArray(b.selections)
          ? (b.selections as unknown[]).map((s) => {
              const o = (s ?? {}) as Body;
              return {
                itemId: str(o.itemId) ?? '',
                path: str(o.path) ?? '',
                isFolder: bool(o.isFolder) ?? false,
                name: str(o.name),
              } satisfies DriveSelection;
            })
          : undefined;
        const d = await setDrive(deps, id, { enabled: bool(b.enabled), selections });
        return ok({ id: d.id, name: d.name, enabled: d.enabled, selections: d.selections });
      }
      case '/admin/drive/browse': {
        const id = idOf(b.driveId);
        const drive = id ? await deps.state.msDrive(id) : null;
        if (!drive) return bad('No such drive.');
        return ok({ items: await browseDrive(deps.state, drive, str(b.itemId) || undefined) });
      }
      case '/admin/remove': {
        const id = idOf(b.id);
        if (!id) return bad('No such account.');
        return ok(await removeAccount(deps, id));
      }
      case '/admin/run': {
        const id = idOf(b.id);
        if (!id) return bad('No such account.');
        return ok({ started: await runNow(deps, id) });
      }
      case '/oauth/start':
        return ok(await startSignIn(deps.state));
      case '/oauth/callback': {
        const a = await finishSignIn(deps.state, {
          code: str(b.code),
          state: str(b.state),
          error: str(b.error),
          errorDescription: str(b.errorDescription),
        });
        return ok({ upn: a.upn });
      }
      default:
        return { status: 404, body: { error: 'not found' } };
    }
  } catch (err) {
    if (err instanceof AccountError || err instanceof MsAuthError) return bad(err.message);
    if (err instanceof GraphError) return { status: 502, body: { error: err.message } };
    throw err;
  }
}
