import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
} from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Mantle Desktop — shell around the owner UI.
 *
 * The UI is the standalone `next build` of client/web, staged into ui/ by
 * scripts/build-ui.sh and run here as a utilityProcess bound to 127.0.0.1
 * (MANTLE_DESKTOP_RENDERER_URL overrides it for dev against a dev server).
 * The shell is a NATIVE client in the same trust stance as the mobile
 * companion: the credential is the bearer token the login page mints; CORS is
 * a browser concern the shell fences inside its own network layer (see
 * fenceBrainSession), scoped strictly to the user-configured brain.
 */

type Profile = {
  id: string;
  origin: string;
  name: string;
  version?: string;
  lastUsedAt?: number;
};

// ── Small JSON stores under userData (config, never secrets — tokens live in
//    each profile's session partition, exactly like the browser) ─────────────

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

const profilesPath = () => join(app.getPath('userData'), 'profiles.json');
const loadProfiles = () => {
  const parsed = readJson<Profile[]>(profilesPath(), []);
  return Array.isArray(parsed) ? parsed : [];
};
const saveProfiles = (profiles: Profile[]) => writeJson(profilesPath(), profiles);

/** Shell-level config. `uiPort` is STICKY on purpose: localStorage (and the
 *  bearer in it) is origin-scoped, so changing the embedded server's port
 *  changes the origin and logs every profile out. Allocated once, reused for
 *  the life of the install; reallocated only if something else took it. */
type ShellConfig = { uiPort?: number };
const configPath = () => join(app.getPath('userData'), 'shell.json');
const loadConfig = () => readJson<ShellConfig>(configPath(), {});
const saveConfig = (config: ShellConfig) => writeJson(configPath(), config);

// ── Token vault ──────────────────────────────────────────────────────────────
//
// The bearer at rest, encrypted with Electron safeStorage (OS keychain-backed:
// Keychain / DPAPI / libsecret) — the mobile companion's posture, replacing
// localStorage's plaintext leveldb. Where a keychain is absent (bare Linux)
// it falls back to a 0600 file, which is no worse than localStorage was.
// Access is scoped: only registered app-window webContents may use the IPC,
// each mapped to its own profile.

const vaultFile = (profileId: string) => join(app.getPath('userData'), 'vault', `${profileId}.tok`);
const windowProfiles = new Map<number, string>();

function vaultRead(profileId: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(vaultFile(profileId), 'utf8')) as {
      encrypted?: boolean;
      data?: string;
    };
    if (typeof raw.data !== 'string') return null;
    const buf = Buffer.from(raw.data, 'base64');
    return raw.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return null;
  }
}

function vaultWrite(profileId: string, token: string): void {
  const path = vaultFile(profileId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const encrypted = safeStorage.isEncryptionAvailable();
  const data = encrypted ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
  writeFileSync(path, JSON.stringify({ v: 1, encrypted, data: data.toString('base64') }), {
    mode: 0o600,
  });
}

// ── Profile helpers ──────────────────────────────────────────────────────────

/** URL → origin. Unlike the mobile app, a bare host gets https:// prefixed. */
function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('empty URL');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`unsupported protocol ${url.protocol}`);
  }
  return url.origin;
}

/** Probe-before-save, the mobile pattern: GET /api/version, require a version
 *  string. net.fetch runs in the main process — native HTTP, no CORS. */
async function probeBrain(origin: string): Promise<string> {
  const res = await net.fetch(`${origin}/api/version`, {
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
  if (!body || typeof body.version !== 'string') throw new Error('not a Mantle server');
  return body.version;
}

// ── Embedded UI server ───────────────────────────────────────────────────────

// Packaged, the ui/ tree is asar-UNPACKED (a utilityProcess needs real files
// on disk); unpackaged it sits beside out/.
const UI_DIR = (() => {
  const plain = join(__dirname, '../../ui');
  const unpacked = plain.replace('app.asar', 'app.asar.unpacked');
  return unpacked !== plain && existsSync(unpacked) ? unpacked : plain;
})();

const ICON_PATH = join(__dirname, '../../resources/icon.png').replace(
  'app.asar',
  'app.asar.unpacked',
);

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let uiServer: { port: number; proc: Electron.UtilityProcess } | null = null;

/** Resolve the URL the app windows load: the dev override, or the embedded
 *  standalone server (spawned on first use). `brainOrigin` becomes the server
 *  process's MANTLE_SERVER_ORIGIN so the root layout's SSR appearance fetch
 *  brands the first paint — spawn-time only, so with several brains open at
 *  once, later windows SSR the first brain's branding (cosmetic; the window's
 *  own data all comes from its preload-injected env). */
async function ensureRendererUrl(brainOrigin: string): Promise<string> {
  const override = process.env.MANTLE_DESKTOP_RENDERER_URL;
  if (override) return override;
  if (uiServer) return `http://127.0.0.1:${uiServer.port}`;

  const entry = readJson<{ server?: string }>(join(UI_DIR, 'entry.json'), {});
  if (!entry.server) {
    throw new Error(
      'Embedded UI not found. Build it with:  pnpm -C client/desktop build:ui\n' +
        '(or point MANTLE_DESKTOP_RENDERER_URL at a client/web dev server)',
    );
  }

  const config = loadConfig();
  let port = config.uiPort ?? 0;
  if (!port || !(await portIsFree(port))) {
    port = await getFreePort();
    saveConfig({ ...config, uiPort: port });
  }

  const proc = utilityProcess.fork(join(UI_DIR, entry.server), [], {
    serviceName: 'mantle-ui',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      MANTLE_SERVER_ORIGIN: brainOrigin,
    },
  });
  uiServer = { port, proc };
  proc.on('exit', () => {
    if (uiServer?.proc === proc) uiServer = null;
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await net.fetch(`${url}/env.js`, { signal: AbortSignal.timeout(2_000), cache: 'no-store' });
      return url;
    } catch {
      if (Date.now() > deadline) throw new Error('embedded UI server did not become ready');
      await delay(250);
    }
  }
}

// ── Native-parity CORS fencing ────────────────────────────────────────────────
//
// The server's gate never rejects by Origin — it only decides whether to emit
// ACAO headers, and skips CORS entirely for requests with no Origin header
// (server/web/server/middleware/gate.ts). Native clients (the mobile app,
// curl) therefore need no CORS setup. Electron is native too; only the
// embedded Chromium enforces CORS on itself. So, for the configured brain
// origin ONLY: declare ourselves native (drop Origin on the way out) and
// satisfy the renderer's own check (supply ACAO on the way in). Nothing about
// the server's browser-facing posture changes — a real browser tab can't do this.

function fenceBrainSession(
  ses: Electron.Session,
  brainOrigin: string,
  rendererOrigin: string,
): void {
  const brainUrls = { urls: [`${brainOrigin}/*`] };

  ses.webRequest.onBeforeSendHeaders(brainUrls, ({ requestHeaders }, callback) => {
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === 'origin') delete requestHeaders[key];
    }
    callback({ requestHeaders });
  });

  ses.webRequest.onHeadersReceived(brainUrls, ({ responseHeaders = {} }, callback) => {
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase().startsWith('access-control-')) delete responseHeaders[key];
    }
    responseHeaders['Access-Control-Allow-Origin'] = ['*'];
    responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PATCH, PUT, DELETE, OPTIONS'];
    // Last-Event-ID rides SSE resume; Idempotency-Key rides turn POST retries.
    responseHeaders['Access-Control-Allow-Headers'] = [
      'Authorization, Content-Type, Idempotency-Key, Last-Event-ID',
    ];
    responseHeaders['Access-Control-Expose-Headers'] = ['*'];
    callback({ responseHeaders });
  });

  // The Next app's /env.js (which reads the SERVER PROCESS's env) must not win
  // over the preload-injected __MANTLE_ENV__ carrying this window's brain.
  ses.webRequest.onBeforeRequest({ urls: [`${rendererOrigin}/env.js*`] }, (_details, callback) => {
    callback({ redirectURL: 'data:text/javascript,// Mantle Desktop provides __MANTLE_ENV__' });
  });
}

// ── Windows ───────────────────────────────────────────────────────────────────

let connectWindow: BrowserWindow | null = null;
/** Most recent app window + the URL it serves — deep links and notification
 *  clicks land here. */
let appWindow: BrowserWindow | null = null;
let appRendererUrl: string | null = null;

function focusOrOpen(): void {
  if (appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.show();
    appWindow.focus();
    return;
  }
  const lastUsed = loadProfiles()
    .filter((p) => p.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
  if (lastUsed) openAppWindow(lastUsed).catch(reportWindowError);
  else openConnectWindow();
}

// ── Deep links (mantle://) ────────────────────────────────────────────────────
//
// mantle://n/<id> (the canonical type-agnostic permalink responders embed)
// maps to the in-app /n/<id> route; any mantle://<path> maps the same way.
// The link names no brain — it lands in the current (or last-used) one.

let pendingDeepLinkPath: string | null = null;

function deepLinkToPath(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== 'mantle:') return null;
    return `/${url.host}${url.pathname}${url.search}`.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

function handleDeepLink(link: string): void {
  const path = deepLinkToPath(link);
  if (!path) return;
  if (appWindow && !appWindow.isDestroyed() && appRendererUrl) {
    appWindow.show();
    appWindow.focus();
    void appWindow.loadURL(new URL(path, appRendererUrl).toString());
  } else {
    pendingDeepLinkPath = path;
    focusOrOpen();
  }
}

const deepLinkInArgv = (argv: string[]) => argv.find((a) => a.startsWith('mantle://'));

function openConnectWindow(): void {
  if (connectWindow && !connectWindow.isDestroyed()) {
    connectWindow.focus();
    return;
  }
  connectWindow = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/connect.js'),
      sandbox: true,
    },
  });
  connectWindow.setMenuBarVisibility(false);
  if (process.env.ELECTRON_RENDERER_URL) {
    void connectWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void connectWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function openAppWindow(profile: Profile): Promise<void> {
  const rendererUrl = await ensureRendererUrl(profile.origin);
  const rendererOrigin = new URL(rendererUrl).origin;
  const partition = `persist:brain-${profile.id}`;
  fenceBrainSession(session.fromPartition(partition), profile.origin, rendererOrigin);

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    webPreferences: {
      partition,
      preload: join(__dirname, '../preload/app.js'),
      sandbox: true,
      additionalArguments: [
        `--mantle-env=${JSON.stringify({ apiBase: profile.origin, serverOrigin: profile.origin })}`,
      ],
    },
  });
  win.once('ready-to-show', () => win.show());

  // Chromium batch-flushes cookies; an abrupt exit can lose the presence
  // cookie while localStorage (the token) survives. Flush on close so a
  // normal quit never relies on the batch timer.
  win.on('close', () => {
    void session.fromPartition(partition).cookies.flushStore();
  });

  // Everything that isn't the app UI opens in the system browser — share
  // links and doc links target the brain origin by design.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== rendererOrigin) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  win.webContents.on('did-fail-load', (_event, _code, description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    dialog.showErrorBox('Mantle Desktop', `Could not load the owner UI (${description}).`);
    openConnectWindow();
    win.close();
  });

  appWindow = win;
  appRendererUrl = rendererUrl;
  const webContentsId = win.webContents.id;
  windowProfiles.set(webContentsId, profile.id);
  win.on('closed', () => {
    windowProfiles.delete(webContentsId);
    if (appWindow === win) {
      appWindow = null;
      appRendererUrl = null;
    }
  });

  const initialPath = pendingDeepLinkPath ?? '/';
  pendingDeepLinkPath = null;
  void win.loadURL(new URL(initialPath, rendererUrl).toString());
}

function reportWindowError(error: unknown): void {
  dialog.showErrorBox('Mantle Desktop', error instanceof Error ? error.message : String(error));
  openConnectWindow();
}

// ── IPC (the connect screen's whole API) ──────────────────────────────────────

type AddResult = { ok: true; profile: Profile } | { ok: false; error: string };

function registerIpc(): void {
  ipcMain.handle('shell:info', () => ({ version: app.getVersion() }));

  // Fired by the UI's DesktopBridge (client/web/components/desktop) — only
  // while its window is hidden, so a notification is a "come back" signal.
  ipcMain.on('desktop:notify', (_event, payload: { title?: unknown; body?: unknown }) => {
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : 'Mantle';
    const body = typeof payload?.body === 'string' ? payload.body.slice(0, 300) : undefined;
    const notification = new Notification({ title, body, icon: ICON_PATH });
    notification.on('click', focusOrOpen);
    notification.show();
  });

  ipcMain.on('desktop:badge', (_event, count: unknown) => {
    if (typeof count === 'number' && Number.isFinite(count)) {
      app.setBadgeCount(Math.max(0, Math.floor(count)));
    }
  });

  ipcMain.on('vault:get', (event) => {
    const profileId = windowProfiles.get(event.sender.id);
    event.returnValue = profileId ? vaultRead(profileId) : null;
  });
  ipcMain.on('vault:set', (event, token: unknown) => {
    const profileId = windowProfiles.get(event.sender.id);
    if (profileId && typeof token === 'string' && token.length > 0 && token.length < 8192) {
      vaultWrite(profileId, token);
    }
  });
  ipcMain.on('vault:clear', (event) => {
    const profileId = windowProfiles.get(event.sender.id);
    if (profileId) rmSync(vaultFile(profileId), { force: true });
  });

  ipcMain.handle('profiles:list', () => loadProfiles());

  ipcMain.handle('profiles:add', async (_event, rawUrl: string): Promise<AddResult> => {
    let origin: string;
    try {
      origin = normalizeOrigin(String(rawUrl));
    } catch {
      return { ok: false, error: 'That does not look like a valid URL.' };
    }
    try {
      const version = await probeBrain(origin);
      const profiles = loadProfiles();
      const existing = profiles.find((p) => p.origin === origin);
      if (existing) {
        existing.version = version;
        saveProfiles(profiles);
        return { ok: true, profile: existing };
      }
      const profile: Profile = {
        id: randomUUID(),
        origin,
        name: new URL(origin).hostname,
        version,
      };
      saveProfiles([...profiles, profile]);
      return { ok: true, profile };
    } catch {
      return { ok: false, error: `Couldn't reach a Mantle server at ${origin}.` };
    }
  });

  ipcMain.handle('profiles:remove', (_event, id: string) => {
    saveProfiles(loadProfiles().filter((p) => p.id !== id));
  });

  ipcMain.handle('profiles:connect', async (event, id: string) => {
    const profiles = loadProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return { ok: false, error: 'Unknown brain — refresh the list.' };
    profile.lastUsedAt = Date.now();
    saveProfiles(profiles);
    try {
      await openAppWindow(profile);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    BrowserWindow.fromWebContents(event.sender)?.close();
    return { ok: true };
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        label: 'Brain',
        submenu: [
          {
            label: 'Switch Brain…',
            accelerator: 'CmdOrCtrl+Shift+B',
            click: () => openConnectWindow(),
          },
        ],
      },
    ]),
  );
}

let tray: Tray | null = null;

function setupTray(): void {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip('Mantle Desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mantle', click: focusOrOpen },
      { label: 'Switch Brain…', click: () => openConnectWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', focusOrOpen);
}

/** Updates ride GitHub releases (the repo's tag-push publish flow). Download
 *  in the background, notify once, install on QUIT — never a surprise
 *  restart. Packaged builds only; on macOS electron-updater additionally
 *  requires a signed app before it will apply anything. */
function setupAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    const notification = new Notification({
      title: 'Mantle Desktop update ready',
      body: `v${info.version} installs when you quit the app.`,
      icon: ICON_PATH,
    });
    notification.show();
  });
  autoUpdater.on('error', () => {
    /* offline / no release yet — silent; next interval retries */
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  void check();
  setInterval(check, 4 * 60 * 60 * 1000);
}

// One instance only — the embedded UI server's sticky port is a single
// resource, and a second instance would steal it (logging the first one out).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // On Linux/Windows a mantle:// activation arrives as a second instance.
    const link = deepLinkInArgv(argv);
    if (link) handleDeepLink(link);
    else focusOrOpen();
  });

  // macOS delivers deep links as open-url events instead.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  void app.whenReady().then(() => {
    if (app.isPackaged) app.setAsDefaultProtocolClient('mantle');
    registerIpc();
    buildMenu();
    setupTray();
    setupAutoUpdate();

    // A cold start via deep link carries the URL in argv (Linux/Windows).
    const link = deepLinkInArgv(process.argv);
    if (link) pendingDeepLinkPath = deepLinkToPath(link);

    // Relaunch lands you back in the brain you were using; the persisted
    // partition still holds the bearer, so no re-login.
    const lastUsed = loadProfiles()
      .filter((p) => p.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
    if (lastUsed) openAppWindow(lastUsed).catch(reportWindowError);
    else openConnectWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) focusOrOpen();
    });
  });

  app.on('will-quit', () => {
    uiServer?.proc.kill();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
