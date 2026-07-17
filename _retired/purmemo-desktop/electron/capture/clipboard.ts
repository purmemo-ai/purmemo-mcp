/**
 * Clipboard monitor — Phase 3 passive capture.
 *
 * Polls clipboard every 1s. When new substantial content is detected:
 * - Sends it to the renderer for the user to review/save
 * - Deduplicates using DJB2 hash (same approach as Chrome extension background.js)
 */

import { clipboard, ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';

// Accept any store that has a clipboardCaptureEnabled boolean field
type ClipboardStore = Store<{ clipboardCaptureEnabled: boolean; [key: string]: unknown }>;

// DJB2 hash — same algorithm used in chrome ext/background.js for content dedup
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep as unsigned 32-bit int
  }
  return hash;
}

const MIN_LENGTH = 100; // chars — ignore short snippets (URLs, short phrases)
const POLL_INTERVAL_MS = 1000;
const DEBOUNCE_STABLE_MS = 2000; // clipboard must be stable for 2s before we show toast

let lastHash = 0;
let lastText = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startClipboardMonitor(store: ClipboardStore, getWindow: () => BrowserWindow | null) {
  if (pollInterval) return; // already running

  pollInterval = setInterval(() => {
    const enabled = store.get('clipboardCaptureEnabled', true);
    if (!enabled) return;

    let text: string;
    try {
      text = clipboard.readText();
    } catch {
      return; // clipboard read can fail if empty or unavailable
    }

    if (text.length < MIN_LENGTH) return;

    const hash = djb2Hash(text);
    if (hash === lastHash) return; // unchanged

    lastHash = hash;
    lastText = text;

    // Debounce: only notify after clipboard has been stable for DEBOUNCE_STABLE_MS
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const win = getWindow();
      if (!win) return;
      win.webContents.send('clipboard-content', text);
    }, DEBOUNCE_STABLE_MS);
  }, POLL_INTERVAL_MS);
}

export function stopClipboardMonitor() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// IPC handlers for renderer responses to clipboard toasts
export function registerClipboardIpcHandlers() {
  ipcMain.on('clipboard-dismiss', () => {
    // User dismissed the toast — reset debounce so same content won't re-trigger
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  ipcMain.on('clipboard-save', (_event, text: string) => {
    // Main process doesn't save directly — renderer makes the API call.
    // This handler exists for future use (e.g., saving from main process when window hidden).
    console.log(`[clipboard] Save requested for ${text.length} chars`);
  });
}
