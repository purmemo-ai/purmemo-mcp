import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification, globalShortcut } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import {
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  deleteTokens,
} from './keychain';
import {
  startClipboardMonitor,
  stopClipboardMonitor,
  registerClipboardIpcHandlers,
} from './capture/clipboard';
import {
  startWindowMonitor,
  stopWindowMonitor,
} from './capture/window';
import {
  syncCursorHistory,
  triggerCursorSync,
  getCursorTrayLabel,
} from './capture/cursor';
import { reportIncident } from './incident-reporter';

// ── Config ────────────────────────────────────────────────────────────────────

const DASHBOARD_URL = 'https://app.purmemo.ai/dashboard';
const LOGIN_URL = 'https://app.purmemo.ai/login';
const API_BASE = 'https://api.purmemo.ai';

// Non-sensitive config only — tokens live in OS keychain via keychain.ts
interface ConfigSchema {
  userEmail: string;
  clipboardCaptureEnabled: boolean;
  // Cursor auto-sync state (Phase 5)
  cursorLastSyncedAt: string | null;
  cursorSyncedIds: string[];
  cursorTotalMemories: number;
  cursorFirstSyncDone: boolean;
}

const config = new Store<ConfigSchema>({
  name: 'purmemo-config',
});

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
let isQuitting = false;

// ── Token helpers ─────────────────────────────────────────────────────────────

function decodeJwtExpiration(token: string): number | null {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

async function isTokenExpiredSoon(bufferSeconds = 300): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return true;
  const exp = decodeJwtExpiration(token);
  if (!exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return (exp - now) < bufferSeconds;
}

/**
 * Refresh the access token using the stored refresh token.
 * After a successful refresh, syncs the new token into the renderer's
 * localStorage so the web app stays authenticated without a reload.
 */
async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Refresh token expired — clear keychain and send user to login
        await deleteTokens();
        config.delete('userEmail');
        if (mainWindow) mainWindow.loadURL(LOGIN_URL);
        updateTrayMenu();
      }
      return false;
    }

    const data = await response.json() as { access_token: string; refresh_token: string };
    await setAccessToken(data.access_token);
    await setRefreshToken(data.refresh_token);

    // Sync fresh tokens into renderer localStorage so web app stays in sync
    await syncTokensToRenderer(data.access_token, data.refresh_token);

    return true;
  } catch {
    return false;
  }
}

/**
 * Push updated tokens into the renderer's localStorage.
 * Called after every background refresh so the web app never sees a stale token.
 */
async function syncTokensToRenderer(accessToken: string, refreshToken: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.webContents.executeJavaScript(`
      (function(access, refresh) {
        localStorage.setItem('purmemo_api_key', access);
        localStorage.setItem('purmemo_refresh_token', refresh);
      })(${JSON.stringify(accessToken)}, ${JSON.stringify(refreshToken)})
    `);
  } catch { /* renderer may not be ready — next refresh cycle will retry */ }
}

function startTokenRefreshTimer() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = setInterval(async () => {
    const token = await getAccessToken();
    if (!token) {
      clearInterval(tokenRefreshTimer!);
      tokenRefreshTimer = null;
      return;
    }
    if (await isTokenExpiredSoon(300)) {
      await refreshAccessToken();
    }
  }, 60_000); // check every minute
}

// ── Window ────────────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Purmemo',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Determine start URL based on whether we already have tokens in keychain
  getAccessToken().then(token => {
    mainWindow?.loadURL(token ? DASHBOARD_URL : LOGIN_URL);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Open DevTools in dev so we can see preload console output
    if (process.env.NODE_ENV !== 'production') {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Hide to tray on close instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });

  // Detect navigation away from /login — extract tokens the web app just stored
  mainWindow.webContents.on('did-navigate', async (_event, url) => {
    if (!url.includes('/login')) {
      await extractAndStoreTokens();
    }
  });

  mainWindow.webContents.on('did-navigate-in-page', async (_event, url) => {
    if (!url.includes('/login')) {
      await extractAndStoreTokens();
    }
  });
}

/**
 * After the web app handles login/OAuth, read tokens from renderer localStorage
 * and promote them to the OS keychain for persistent secure storage.
 */
async function extractAndStoreTokens(): Promise<void> {
  if (!mainWindow) return;
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (function() {
        const access = localStorage.getItem('purmemo_api_key');
        const refresh = localStorage.getItem('purmemo_refresh_token');
        const user = localStorage.getItem('purmemo_user');
        return { access, refresh, user };
      })()
    `) as { access: string | null; refresh: string | null; user: string | null };

    if (result.access) await setAccessToken(result.access);
    if (result.refresh) await setRefreshToken(result.refresh);
    if (result.user) {
      try {
        const user = JSON.parse(result.user) as { email?: string };
        if (user.email) config.set('userEmail', user.email);
      } catch { /* ignore */ }
    }

    if (result.access) {
      startTokenRefreshTimer();
      updateTrayMenu();
    }
  } catch { /* renderer not ready */ }
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Purmemo — your memory, always on');
  updateTrayMenu();

  tray.on('click', () => {
    if (!mainWindow) {
      createMainWindow();
    } else {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
        if (process.platform === 'darwin') app.dock.hide();
      } else {
        mainWindow.show();
        if (process.platform === 'darwin') app.dock.show();
      }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const userEmail = config.get('userEmail', '');
  const clipboardEnabled = config.get('clipboardCaptureEnabled', true);

  // isLoggedIn is async (keychain) — we use userEmail as proxy since it's set
  // in config at the same time tokens are stored. Accurate enough for UI.
  const isLoggedIn = !!userEmail;

  const menu = Menu.buildFromTemplate([
    ...(userEmail ? [
      { label: userEmail, enabled: false },
      { type: 'separator' as const },
    ] : []),
    {
      label: 'Open Purmemo',
      accelerator: 'CmdOrCtrl+Shift+P',
      click: () => {
        if (!mainWindow) createMainWindow();
        mainWindow?.show();
        if (process.platform === 'darwin') app.dock.show();
      },
    },
    { type: 'separator' as const },
    {
      label: `Clipboard capture: ${clipboardEnabled ? 'On' : 'Off'}`,
      click: () => {
        config.set('clipboardCaptureEnabled', !clipboardEnabled);
        updateTrayMenu();
      },
    },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      label: getCursorTrayLabel(config as any),
      enabled: false,
    },
    { type: 'separator' as const },
    ...(isLoggedIn ? [{
      label: 'Sign out',
      click: async () => {
        await deleteTokens();
        config.delete('userEmail');
        if (tokenRefreshTimer) { clearInterval(tokenRefreshTimer); tokenRefreshTimer = null; }
        if (mainWindow) mainWindow.loadURL(LOGIN_URL);
        updateTrayMenu();
      },
    }] : []),
    {
      label: 'Quit Purmemo',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Renderer requests the current access token — returns from keychain
ipcMain.handle('get-token', async () => getAccessToken());

// Renderer triggers a manual token refresh (e.g. on 401 response)
ipcMain.handle('refresh-token', async () => refreshAccessToken());

// Dev: manually fire a test toast (called via DevTools console: electronAPI.testToast())
ipcMain.on('test-toast', () => {
  mainWindow?.webContents.send('clipboard-content', 'This is a test clipboard capture from Purmemo desktop. If you can see this toast, the clipboard IPC pipeline is working correctly end-to-end.');
});

// Dev: manually trigger context injection (called via DevTools: electronAPI.testContextInject())
ipcMain.on('test-context-inject', async () => {
  const token = await getAccessToken();
  if (!token) { console.log('[purmemo] no token — login first'); return; }
  const { triggerContextInject } = require('./capture/window');
  await triggerContextInject(token, 'Test App');
});

// Renderer forwards a caught page error to the incident hub (needs keychain,
// which is main-process only). Fire-and-forget; never throws.
ipcMain.on('incident:report', (_event, payload: { message?: string; component?: string; route?: string }) => {
  reportIncident(payload?.message, {
    component: payload?.component ?? 'renderer',
    route: payload?.route,
  });
});

// Renderer notifies that user saved a memory via clipboard toast
ipcMain.on('memory-saved', () => {
  if (Notification.isSupported()) {
    new Notification({
      title: 'Purmemo',
      body: 'Memory saved.',
      silent: true,
    }).show();
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createTray();
  createMainWindow();

  // Start clipboard monitor — sends 'clipboard-content' IPC to renderer when triggered
  registerClipboardIpcHandlers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  startClipboardMonitor(config as any, () => mainWindow);

  // Start window monitor — injects Purmemo context when user switches to an AI app
  // Also fires onCursorFocusLoss when user leaves Cursor, triggering incremental sync
  startWindowMonitor(getAccessToken, () => mainWindow, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    triggerCursorSync(getAccessToken, config as any, updateTrayMenu);
  });

  // If already authenticated from a previous session, start refresh timer + catch-up sync
  const token = await getAccessToken();
  if (token) {
    startTokenRefreshTimer();
    // Startup catch-up: sync any Cursor conversations since last sync
    // (covers sessions that ran while the desktop app was closed)
    setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      syncCursorHistory(getAccessToken, config as any, updateTrayMenu).catch(() => {});
    }, 5000); // 5s delay — let app fully initialize first
  }

  app.on('activate', () => {
    if (!mainWindow) {
      createMainWindow();
    } else {
      mainWindow.show();
      if (process.platform === 'darwin') app.dock.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── Crash observability ─────────────────────────────────────────────────────
// Report normalized signatures of uncaught main-process errors to the incident
// hub. We only OBSERVE — the errors keep their normal behavior (logged as before).
process.on('uncaughtException', (err) => {
  console.error('[purmemo] uncaughtException', err);
  reportIncident(err?.stack || err?.message || String(err), { component: 'main' });
});

process.on('unhandledRejection', (reason) => {
  const r = reason as { stack?: string; message?: string } | undefined;
  console.error('[purmemo] unhandledRejection', reason);
  reportIncident(r?.stack || r?.message || String(reason), { component: 'main' });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  stopClipboardMonitor();
  stopWindowMonitor();
});

// Open external links in the system browser, not in the app
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') && !url.includes('app.purmemo.ai')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
});
