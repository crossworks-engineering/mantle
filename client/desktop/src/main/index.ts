import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  session,
  shell,
  utilityProcess,
} from 'electron';

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

const UI_DIR = join(__dirname, '../../ui');

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

  void win.loadURL(rendererUrl);
}

function reportWindowError(error: unknown): void {
  dialog.showErrorBox('Mantle Desktop', error instanceof Error ? error.message : String(error));
  openConnectWindow();
}

// ── IPC (the connect screen's whole API) ──────────────────────────────────────

type AddResult = { ok: true; profile: Profile } | { ok: false; error: string };

function registerIpc(): void {
  ipcMain.handle('shell:info', () => ({ version: app.getVersion() }));

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

// One instance only — the embedded UI server's sticky port is a single
// resource, and a second instance would steal it (logging the first one out).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      openConnectWindow();
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    buildMenu();

    // Relaunch lands you back in the brain you were using; the persisted
    // partition still holds the bearer, so no re-login.
    const lastUsed = loadProfiles()
      .filter((p) => p.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
    if (lastUsed) openAppWindow(lastUsed).catch(reportWindowError);
    else openConnectWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openConnectWindow();
    });
  });

  app.on('will-quit', () => {
    uiServer?.proc.kill();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
