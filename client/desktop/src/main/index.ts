import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  session,
  shell,
} from 'electron';

/**
 * Mantle Desktop — Phase 0 shell.
 *
 * The Mantle owner UI (client/web) is loaded from a URL and pointed at a
 * user-chosen brain. The shell is a NATIVE client in the same trust stance as
 * the mobile companion: the credential is the bearer token the login page
 * mints; CORS is a browser concern the shell fences inside its own network
 * layer (see fenceBrainSession), scoped strictly to the configured brain.
 *
 * Phase 0 loads the UI from the client/web dev server; Phase 1 replaces that
 * with the embedded standalone build.
 */

const RENDERER_URL = process.env.MANTLE_DESKTOP_RENDERER_URL ?? 'http://localhost:3001';

type Profile = {
  id: string;
  origin: string;
  name: string;
  version?: string;
  lastUsedAt?: number;
};

// ── Server profiles (config, not secrets — tokens live in the per-profile
//    session partition, exactly like the browser's localStorage) ──────────────

const profilesPath = () => join(app.getPath('userData'), 'profiles.json');

function loadProfiles(): Profile[] {
  try {
    const parsed = JSON.parse(readFileSync(profilesPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProfiles(profiles: Profile[]): void {
  mkdirSync(dirname(profilesPath()), { recursive: true });
  writeFileSync(profilesPath(), JSON.stringify(profiles, null, 2));
}

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

  // The Next app's /env.js (which reads the DEV SERVER's env) must not win over
  // the preload-injected __MANTLE_ENV__ carrying the user's chosen brain.
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

function openAppWindow(profile: Profile): void {
  const rendererOrigin = new URL(RENDERER_URL).origin;
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
    dialog.showErrorBox(
      'Mantle Desktop',
      `Could not load the owner UI at ${RENDERER_URL} (${description}).\n\n` +
        'Phase 0 needs the client dev server running:\n  pnpm dev:fe -- --port 3001',
    );
    openConnectWindow();
    win.close();
  });

  void win.loadURL(RENDERER_URL);
}

// ── IPC (the connect screen's whole API) ──────────────────────────────────────

type AddResult = { ok: true; profile: Profile } | { ok: false; error: string };

function registerIpc(): void {
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

  ipcMain.handle('profiles:connect', (event, id: string) => {
    const profiles = loadProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return { ok: false, error: 'Unknown brain — refresh the list.' };
    profile.lastUsedAt = Date.now();
    saveProfiles(profiles);
    openAppWindow(profile);
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

void app.whenReady().then(() => {
  registerIpc();
  buildMenu();

  // Relaunch lands you back in the brain you were using; the persisted
  // partition still holds the bearer, so no re-login.
  const lastUsed = loadProfiles()
    .filter((p) => p.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
  if (lastUsed) openAppWindow(lastUsed);
  else openConnectWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openConnectWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
