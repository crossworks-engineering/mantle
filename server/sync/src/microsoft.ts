/**
 * Microsoft 365 for the Sync sidecar (Sync service plan M3;
 * docs/microsoft-graph-ingest.md): the sign-in (authorization code with PKCE
 * and the app's client secret), the tokens (refreshed here, one refresh at a
 * time per account), Microsoft Graph calls, and drive discovery. Ported from
 * the brain's old packages/microsoft (removed in M4).
 *
 * The app and every token live in the brain (service_state, sealed there).
 * The sidecar gives rclone a fresh access token per command (files.ts).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  NET_TIMEOUTS,
  errorMessage,
  parseRetryAfterMs,
  timeoutSignal,
  withRetry,
} from '@mantle/std';
import type { DriveSelection, MsAccount, MsApp, MsDrive, State } from './state';

export const AUTHORITY = 'https://login.microsoftonline.com';
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH = `${GRAPH_ORIGIN}/v1.0`;
/** The scopes asked at sign-in, as before M4. */
export const SCOPES =
  'offline_access openid profile Files.Read.All Sites.Read.All Mail.Read Mail.Send Calendars.Read';
export const MAIL_SEND_SCOPE = 'Mail.Send';
/** A token this close to its end is refreshed first (a drive file's stream
 *  runs on the token it starts with). */
const EXPIRY_SKEW_MS = 10 * 60_000;
/** How long a sign-in may take, from Connect to the callback. */
export const OAUTH_TTL_MS = 10 * 60_000;
/** The longest error text kept. */
const ERROR_MAX = 300;

/** A sign-in or token problem the person can act on (its text is shown). */
export class MsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MsAuthError';
  }
}

/** Microsoft Graph answered with an error. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** An ltree label from free text: lowercase letters, digits and `_`. */
function label(text: string, max: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/, '');
}

/** Where an account's files and mail land: `microsoft.<user>_<4 hex of the
 *  domain>`, as before M4 (so a reconnected account keeps its branch). */
export function msBranchPath(upn: string): string {
  const at = upn.lastIndexOf('@');
  // 59: with `_` and 4 hex the label stays within ltree's 64 the brain takes.
  const local = label(at < 0 ? upn : upn.slice(0, at), 59) || 'account';
  const domain = at < 0 ? '' : upn.slice(at + 1).toLowerCase();
  return `microsoft.${local}_${sha256hex(domain).slice(0, 4)}`;
}

/** A drive's label below its account's branch: its name and 4 hex of its id. */
export function driveLabel(name: string, driveId: string): string {
  return `${label(name, 48) || 'drive'}_${sha256hex(driveId).slice(0, 4)}`;
}

// ── tokens ─────────────────────────────────────────────────────────────────

type TokenAnswer = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

async function tokenRequest(app: MsApp, params: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(`${AUTHORITY}/${encodeURIComponent(app.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...params,
    }).toString(),
    redirect: 'error',
    signal: timeoutSignal(NET_TIMEOUTS.syncGraph),
  });
  const json = (await res.json().catch(() => null)) as
    (TokenAnswer & { error?: string; error_description?: string }) | null;
  if (!res.ok || !json || json.error || !json.access_token) {
    // Microsoft's own error code and its first line; never a token.
    const desc = (json?.error_description ?? '').split('\n')[0]!.slice(0, 200);
    throw new MsAuthError(
      `Microsoft refused the sign-in (${json?.error ?? res.status})${desc ? `: ${desc}` : ''}`,
    );
  }
  return json;
}

const inflight = new Map<string, Promise<string>>();

/** A valid access token for the account, refreshed first when it is near
 *  its end. One refresh at a time per account (Microsoft rotates the
 *  refresh token: two at once would lose one). */
export async function accessToken(state: State, accountId: string): Promise<string> {
  const a = await state.msAccount(accountId);
  if (!a) throw new MsAuthError('This Microsoft account is not connected.');
  if (a.accessToken && a.expiresAt && a.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return a.accessToken;
  }
  let job = inflight.get(accountId);
  if (!job) {
    job = refresh(state, a).finally(() => inflight.delete(accountId));
    inflight.set(accountId, job);
  }
  return job;
}

async function refresh(state: State, a: MsAccount): Promise<string> {
  const app = await state.msApp();
  if (!app) throw new MsAuthError('The Microsoft app is not set on this box.');
  if (!a.refreshToken) throw new MsAuthError('Connect this Microsoft account again.');
  let t: TokenAnswer;
  try {
    // No `scope` on a refresh: an account consented before a scope was added
    // could not refresh with it (AADSTS65001).
    t = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: a.refreshToken });
  } catch (err) {
    const lastError = `token refresh failed: ${errorMessage(err)}`.slice(0, ERROR_MAX);
    const fresh = await state.msAccount(a.id).catch(() => null);
    if (fresh) await state.putMsAccount({ ...fresh, lastError }).catch(() => {});
    throw err;
  }
  // Read again: the mail switch may have moved meanwhile, or the account
  // been disconnected (then nothing is written back).
  const fresh = await state.msAccount(a.id);
  if (!fresh) throw new MsAuthError('This Microsoft account is not connected.');
  await state.putMsAccount({
    ...fresh,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? fresh.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope ? t.scope.split(' ').filter(Boolean) : fresh.scopes,
    lastError: null,
  });
  return t.access_token;
}

// ── Graph ──────────────────────────────────────────────────────────────────

/** One Graph call: Graph's own origin only, 429 waited out (up to 4 times,
 *  its Retry-After, else 1, 2, 4, 8 s; at most a minute each). */
export async function graph(
  token: string,
  pathOrUrl: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  if (new URL(url).origin !== GRAPH_ORIGIN) throw new GraphError(400, 'not a Graph address');
  const res = await withRetry(
    () =>
      fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'error',
        signal: timeoutSignal(NET_TIMEOUTS.syncGraph),
      }),
    {
      retries: 4,
      isFailure: (r) => r.status === 429,
      delayMs: (retry, failure) =>
        Math.min(
          ('value' in failure ? parseRetryAfterMs(failure.value!.headers) : undefined) ??
            1000 * 2 ** (retry - 1),
          60_000,
        ),
      onRetry: async ({ failure }) => {
        if ('value' in failure) await failure.value!.body?.cancel().catch(() => {});
      },
    },
  );
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, ERROR_MAX);
    throw new GraphError(res.status, `Microsoft Graph answered ${res.status}: ${text}`);
  }
  return res;
}

export async function graphJson<T>(token: string, pathOrUrl: string): Promise<T> {
  return (await (await graph(token, pathOrUrl)).json()) as T;
}

type Page<T> = { value?: T[]; '@odata.nextLink'?: string };

/** Every item of a paged Graph list, at most `maxPages` pages. */
export async function graphAll<T>(token: string, path: string, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  for (let i = 0; next && i < maxPages; i++) {
    const page: Page<T> = await graphJson<Page<T>>(token, next);
    out.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return out;
}

// ── the app and the sign-in ────────────────────────────────────────────────

/** The app as a screen or a tool shows it: the secret masked. */
export function appView(app: MsApp | null) {
  if (!app) return { configured: false as const };
  const s = app.clientSecret;
  return {
    configured: true as const,
    clientId: app.clientId,
    tenant: app.tenant,
    redirectUri: app.redirectUri,
    secretMasked: s.length >= 8 ? `…${s.slice(-4)}` : '••••',
  };
}

const TENANT_RE = /^[A-Za-z0-9.-]{1,100}$/;

/** Save the Microsoft app. A blank secret keeps the stored one. Throws
 *  MsAuthError with a text for the person. */
export async function saveApp(
  state: State,
  input: { clientId: string; clientSecret?: string; tenant?: string; redirectUri: string },
): Promise<MsApp> {
  const existing = await state.msApp();
  const clientId = input.clientId.trim();
  const tenant = (input.tenant ?? '').trim() || 'common';
  const redirectUri = input.redirectUri.trim();
  const clientSecret = (input.clientSecret ?? '').trim() || existing?.clientSecret || '';
  if (!/^[A-Za-z0-9-]{8,100}$/.test(clientId))
    throw new MsAuthError('Enter the application (client) ID.');
  if (!TENANT_RE.test(tenant)) throw new MsAuthError('Enter common, organizations or a tenant id.');
  if (!/^https?:\/\/[^\s]+$/.test(redirectUri) || redirectUri.length > 500)
    throw new MsAuthError('Enter the redirect URI registered on the app.');
  if (!clientSecret || clientSecret.length > 500)
    throw new MsAuthError('Enter the client secret the first time you save.');
  const app = { clientId, clientSecret, tenant, redirectUri };
  await state.putMsApp(app);
  return app;
}

/** Start a sign-in: the address the person opens, and its state. */
export async function startSignIn(state: State): Promise<{ url: string; state: string }> {
  const app = await state.msApp();
  if (!app) throw new MsAuthError('Set the Microsoft app first.');
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const st = randomBytes(16).toString('hex');
  // Sign-ins started and never finished: dropped once past their time.
  for (const old of await state.oauthAll()) {
    if (Date.now() - old.value.at > OAUTH_TTL_MS) await state.deleteOAuth(old.key).catch(() => {});
  }
  await state.putOAuth(st, { verifier, at: Date.now() });
  const u = new URL(`${AUTHORITY}/${encodeURIComponent(app.tenant)}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: 'code',
    redirect_uri: app.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state: st,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: u.toString(), state: st };
}

/** Finish a sign-in (the callback's code). The account, connected or
 *  connected again; its drives found. Throws MsAuthError. */
export async function finishSignIn(
  state: State,
  q: { code?: string; state?: string; error?: string; errorDescription?: string },
): Promise<MsAccount> {
  const st = q.state ?? '';
  if (!/^[0-9a-f]{32}$/.test(st)) throw new MsAuthError('This sign-in has expired. Try again.');
  const pending = await state.oauth(st);
  // Used once, whatever happens next.
  await state.deleteOAuth(st).catch(() => {});
  if (!pending || Date.now() - pending.at > OAUTH_TTL_MS) {
    throw new MsAuthError('This sign-in has expired. Try again.');
  }
  if (q.error) {
    const why = (q.errorDescription || q.error).split('\n')[0]!.slice(0, 200);
    throw new MsAuthError(`Microsoft did not sign in: ${why}`);
  }
  if (!q.code) throw new MsAuthError('This sign-in has expired. Try again.');
  const app = await state.msApp();
  if (!app) throw new MsAuthError('Set the Microsoft app first.');
  const t = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: q.code,
    redirect_uri: app.redirectUri,
    code_verifier: pending.verifier,
    scope: SCOPES,
  });
  const me = await graphJson<{ userPrincipalName?: string; mail?: string; displayName?: string }>(
    t.access_token,
    '/me',
  );
  const upn = (me.userPrincipalName || me.mail || '').trim();
  if (!upn) throw new MsAuthError('Microsoft gave no account name.');
  const existing = (await state.msAccounts()).find(
    (a) => a.upn.toLowerCase() === upn.toLowerCase(),
  );
  const account: MsAccount = {
    id: existing?.id ?? randomUUID(),
    upn,
    displayName: me.displayName ?? existing?.displayName ?? null,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? existing?.refreshToken ?? null,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope ? t.scope.split(' ').filter(Boolean) : [],
    branchPath: existing?.branchPath ?? msBranchPath(upn),
    mail: existing?.mail ?? false,
    mailboxId: existing?.mailboxId ?? null,
    lastError: null,
  };
  await state.putMsAccount(account);
  try {
    await discoverDrives(state, account.id);
  } catch (err) {
    console.warn(`[sync] drive discovery after a sign-in failed: ${errorMessage(err)}`);
  }
  return account;
}

// ── drives ─────────────────────────────────────────────────────────────────

type GraphDrive = { id: string; driveType?: string; name?: string; webUrl?: string };
/** A Graph id as it goes in a path: letters, digits and `!.,_-`. */
const GRAPH_ID_RE = /^[A-Za-z0-9!.,_-]{1,400}$/;

/** Find the account's OneDrive and the libraries of its followed SharePoint
 *  sites. A new drive starts off; one known keeps its switch, selections
 *  and label. Answers the account's drives. */
export async function discoverDrives(state: State, accountId: string): Promise<MsDrive[]> {
  const token = await accessToken(state, accountId);
  const found: Omit<MsDrive, 'id' | 'accountId' | 'branchLabel' | 'enabled' | 'selections'>[] = [];
  try {
    const d = await graphJson<GraphDrive>(token, '/me/drive');
    found.push({
      driveId: d.id,
      driveType: d.driveType ?? 'personal',
      name: d.name ?? 'OneDrive',
      siteName: null,
      webUrl: d.webUrl ?? null,
    });
  } catch {
    // No OneDrive on this account (not provisioned): the sites still count.
  }
  try {
    const sites = await graphAll<{ id: string; displayName?: string; name?: string }>(
      token,
      '/me/followedSites',
    );
    for (const site of sites) {
      if (!GRAPH_ID_RE.test(site.id)) continue;
      try {
        for (const d of await graphAll<GraphDrive>(token, `/sites/${site.id}/drives`)) {
          found.push({
            driveId: d.id,
            driveType: d.driveType ?? 'documentLibrary',
            name: d.name ?? 'Documents',
            siteName: site.displayName ?? site.name ?? null,
            webUrl: d.webUrl ?? null,
          });
        }
      } catch {
        // One site's libraries unreadable: the others still count.
      }
    }
  } catch {
    // No followed sites readable.
  }
  const mine = (await state.msDrives()).filter((d) => d.accountId === accountId);
  for (const f of found) {
    if (!GRAPH_ID_RE.test(f.driveId)) continue;
    const known = mine.find((d) => d.driveId === f.driveId);
    const drive: MsDrive = known
      ? { ...known, name: f.name, siteName: f.siteName, webUrl: f.webUrl, driveType: f.driveType }
      : {
          ...f,
          id: randomUUID(),
          accountId,
          branchLabel: driveLabel(f.name, f.driveId),
          enabled: false,
          selections: [],
        };
    await state.putMsDrive(drive);
    if (!known) mine.push(drive);
  }
  return (await state.msDrives()).filter((d) => d.accountId === accountId);
}

export type BrowseItem = {
  itemId: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  /** The path after the drive root, starting with `/`. */
  path: string | null;
};

type GraphItem = {
  id: string;
  name?: string;
  size?: number;
  folder?: unknown;
  file?: unknown;
  parentReference?: { path?: string };
};

/** An item's path after `root:`, starting with `/`, or null. */
export function itemPathOf(item: GraphItem): string | null {
  const parent = item.parentReference?.path;
  if (!parent || !item.name) return null;
  const i = parent.indexOf('root:');
  if (i < 0) return null;
  let rest = parent.slice(i + 'root:'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Keep it as it is.
  }
  return `${rest.replace(/\/+$/, '')}/${item.name}`;
}

/** One folder of a drive (its root when `itemId` is absent), to choose what
 *  syncs. */
export async function browseDrive(
  state: State,
  drive: MsDrive,
  itemId?: string,
): Promise<BrowseItem[]> {
  if (!GRAPH_ID_RE.test(drive.driveId) || (itemId && !GRAPH_ID_RE.test(itemId))) {
    throw new GraphError(400, 'not a drive item');
  }
  const token = await accessToken(state, drive.accountId);
  const where = itemId ? `items/${itemId}` : 'root';
  const items = await graphAll<GraphItem>(
    token,
    `/drives/${drive.driveId}/${where}/children?$select=id,name,size,folder,file,parentReference&$top=200`,
    5,
  );
  return items.map((it) => ({
    itemId: it.id,
    name: it.name ?? '',
    isFolder: !!it.folder,
    size: typeof it.size === 'number' ? it.size : null,
    path: itemPathOf(it),
  }));
}

/** The drive's selections with each one's path as it is now, read by its
 *  id (a folder renamed or moved since it was chosen). A choice Microsoft no
 *  longer knows (404: deleted) keeps its old path; its files are gone.
 *  Any other error stops the run before it removes anything. Saved back when
 *  a path changed. */
export async function currentSelections(state: State, drive: MsDrive): Promise<DriveSelection[]> {
  if (drive.selections.length === 0) return [];
  const token = await accessToken(state, drive.accountId);
  let moved = false;
  const now: DriveSelection[] = [];
  for (const sel of drive.selections) {
    if (!GRAPH_ID_RE.test(sel.itemId) || !GRAPH_ID_RE.test(drive.driveId)) {
      now.push(sel);
      continue;
    }
    try {
      const it = await graphJson<GraphItem>(
        token,
        `/drives/${drive.driveId}/items/${sel.itemId}?$select=id,name,parentReference`,
      );
      const path = itemPathOf(it);
      if (path && path !== sel.path) {
        moved = true;
        now.push({ ...sel, path, name: it.name ?? sel.name });
      } else now.push(sel);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) now.push(sel);
      else throw err;
    }
  }
  if (moved) {
    const fresh = await state.msDrive(drive.id);
    if (fresh) await state.putMsDrive({ ...fresh, selections: now });
  }
  return now;
}

/** Whether a drive item at `path` (after the root, `/a/b.txt`) with `itemId`
 *  is in the drive's selections: none chosen is the whole drive; a folder
 *  holds its path and everything below; a file matches by id or path. */
export function inSelections(
  selections: DriveSelection[],
  itemId: string | undefined,
  path: string,
): boolean {
  if (selections.length === 0) return true;
  return selections.some((s) =>
    s.isFolder
      ? path === s.path || path.startsWith(`${s.path.replace(/\/+$/, '')}/`)
      : (!!itemId && itemId === s.itemId) || path === s.path,
  );
}
