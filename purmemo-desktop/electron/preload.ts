/**
 * Preload script — context bridge between Electron main process and renderer.
 *
 * Two responsibilities:
 * 1. Expose window.electronAPI for the renderer to call native features
 * 2. Inject the clipboard toast UI once the DOM is ready
 */

import { contextBridge, ipcRenderer } from 'electron';

// ── API bridge ────────────────────────────────────────────────────────────────

export interface ElectronAPI {
  getToken: () => Promise<string>;
  refreshToken: () => Promise<boolean>;
  onMemorySaved: () => void;
  onClipboardContent: (callback: (text: string) => void) => () => void;
  dismissClipboard: () => void;
  saveClipboard: (text: string) => void;
  testToast: () => void;
  testContextInject: () => void;
  isElectron: true;
}

contextBridge.exposeInMainWorld('electronAPI', {
  getToken: () => ipcRenderer.invoke('get-token'),

  refreshToken: () => ipcRenderer.invoke('refresh-token'),

  onMemorySaved: () => ipcRenderer.send('memory-saved'),

  onClipboardContent: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
    ipcRenderer.on('clipboard-content', handler);
    return () => ipcRenderer.removeListener('clipboard-content', handler);
  },

  dismissClipboard: () => ipcRenderer.send('clipboard-dismiss'),

  saveClipboard: (text: string) => ipcRenderer.send('clipboard-save', text),

  testToast: () => ipcRenderer.send('test-toast'),

  testContextInject: () => ipcRenderer.send('test-context-inject'),

  isElectron: true,
} satisfies ElectronAPI);

// ── Clipboard toast ───────────────────────────────────────────────────────────
// Injected directly into the renderer page — no changes needed to the Next.js app.

const API_BASE = 'https://api.purmemo.ai';
const AUTO_DISMISS_MS = 8000;

const TOAST_STYLES = `
  #purmemo-clipboard-toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 999999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 340px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    pointer-events: none;
  }
  .purmemo-toast-card {
    background: rgba(18, 18, 20, 0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 14px;
    padding: 14px 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
    backdrop-filter: blur(20px);
    pointer-events: all;
    animation: purmemo-toast-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }
  .purmemo-toast-card.dismissing {
    animation: purmemo-toast-out 0.2s ease-in forwards;
  }
  .purmemo-toast-label {
    font-size: 11px;
    color: rgba(255,255,255,0.4);
    margin-bottom: 6px;
    letter-spacing: 0.02em;
  }
  .purmemo-toast-preview {
    font-size: 12px;
    color: rgba(255,255,255,0.75);
    line-height: 1.5;
    margin-bottom: 12px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .purmemo-toast-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .purmemo-toast-btn {
    font-size: 12px;
    font-weight: 500;
    border-radius: 8px;
    padding: 6px 14px;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s;
  }
  .purmemo-toast-btn:hover { opacity: 0.85; }
  .purmemo-toast-btn.dismiss {
    background: rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.5);
  }
  .purmemo-toast-btn.save {
    background: rgba(255,255,255,0.92);
    color: #0a0a0a;
  }
  .purmemo-toast-btn.saving {
    opacity: 0.6;
    cursor: default;
  }
  .purmemo-toast-btn.saved {
    background: rgba(134,239,172,0.2);
    color: rgba(134,239,172,0.9);
    border: 1px solid rgba(134,239,172,0.3);
  }
  @keyframes purmemo-toast-in {
    from { opacity: 0; transform: translateY(12px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes purmemo-toast-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(8px) scale(0.96); }
  }
`;

function ensureToastContainer(): HTMLElement {
  let container = document.getElementById('purmemo-clipboard-toast');
  if (!container) {
    // Inject styles once
    const style = document.createElement('style');
    style.textContent = TOAST_STYLES;
    document.head.appendChild(style);

    container = document.createElement('div');
    container.id = 'purmemo-clipboard-toast';
    document.body.appendChild(container);
  }
  return container;
}

function dismissCard(card: HTMLElement, onDone?: () => void) {
  card.classList.add('dismissing');
  card.addEventListener('animationend', () => {
    card.remove();
    onDone?.();
  }, { once: true });
}

// In the preload context, window.electronAPI is not available — use ipcRenderer directly
function preloadGetToken(): Promise<string> {
  return ipcRenderer.invoke('get-token');
}
function preloadRefreshToken(): Promise<boolean> {
  return ipcRenderer.invoke('refresh-token');
}
function preloadDismiss(): void {
  ipcRenderer.send('clipboard-dismiss');
}
function preloadMemorySaved(): void {
  ipcRenderer.send('memory-saved');
}

async function saveToApi(text: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: text,
        source_type: 'desktop_clipboard',
        title: text.slice(0, 80).trim(),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function showClipboardToast(text: string) {
  const container = ensureToastContainer();

  const card = document.createElement('div');
  card.className = 'purmemo-toast-card';

  const label = document.createElement('div');
  label.className = 'purmemo-toast-label';
  label.textContent = 'Save to Purmemo?';

  const preview = document.createElement('div');
  preview.className = 'purmemo-toast-preview';
  preview.textContent = text;

  const actions = document.createElement('div');
  actions.className = 'purmemo-toast-actions';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'purmemo-toast-btn dismiss';
  dismissBtn.textContent = 'Dismiss';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'purmemo-toast-btn save';
  saveBtn.textContent = 'Save';

  actions.appendChild(dismissBtn);
  actions.appendChild(saveBtn);
  card.appendChild(label);
  card.appendChild(preview);
  card.appendChild(actions);
  container.appendChild(card);

  // Auto-dismiss after 8s
  const autoDismissTimer = setTimeout(() => {
    dismissCard(card);
    preloadDismiss();
  }, AUTO_DISMISS_MS);

  dismissBtn.addEventListener('click', () => {
    clearTimeout(autoDismissTimer);
    dismissCard(card);
    preloadDismiss();
  });

  saveBtn.addEventListener('click', async () => {
    clearTimeout(autoDismissTimer);
    saveBtn.textContent = 'Saving…';
    saveBtn.classList.add('saving');
    dismissBtn.style.display = 'none';

    let token = await preloadGetToken();

    // If no token, request a refresh before saving
    if (!token) {
      await preloadRefreshToken();
      token = await preloadGetToken();
    }

    const ok = await saveToApi(text, token);

    if (ok) {
      saveBtn.textContent = 'Saved ✓';
      saveBtn.classList.remove('saving');
      saveBtn.classList.add('saved');
      preloadMemorySaved();
      setTimeout(() => dismissCard(card), 1500);
    } else {
      saveBtn.textContent = 'Failed — retry?';
      saveBtn.classList.remove('saving');
      saveBtn.style.background = 'rgba(239,68,68,0.15)';
      saveBtn.style.color = 'rgba(252,165,165,0.9)';
      saveBtn.addEventListener('click', () => dismissCard(card), { once: true });
    }
  });
}

// Wire IPC listener at preload execution time — NOT inside DOMContentLoaded.
// ipcRenderer.on doesn't need the DOM. Only showClipboardToast does, so we
// defer the actual DOM work until document.body is available.
ipcRenderer.on('clipboard-content', (_event, text: string) => {
  console.log(`[purmemo] clipboard-content received (${text.length} chars)`);

  const render = () => {
    console.log('[purmemo] showing toast');
    showClipboardToast(text);
  };

  if (document.body) {
    render();
  } else {
    window.addEventListener('DOMContentLoaded', render, { once: true });
  }
});

// ── Renderer crash observability ────────────────────────────────────────────
// Install global error listeners on the page and forward the message to the
// main process, which normalizes it and reports to the incident hub with the
// user's keychain token (renderer has no keychain access). Fire-and-forget.
function forwardIncident(message: unknown): void {
  try {
    ipcRenderer.send('incident:report', {
      message: String(message),
      component: 'renderer',
      route: typeof location !== 'undefined' ? location.pathname : undefined,
    });
  } catch {
    // observability must never break the page
  }
}

window.addEventListener('error', (event) => {
  forwardIncident(event.error?.stack || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { stack?: string; message?: string } | undefined;
  forwardIncident(reason?.stack || reason?.message || event.reason);
});

// Log once when preload runs so we can confirm it's active
console.log('[purmemo] preload loaded, clipboard IPC listener registered');
