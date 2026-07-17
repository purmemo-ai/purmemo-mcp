/**
 * Cursor auto-sync — Desktop Phase 5.
 *
 * Watches the Cursor SQLite database (state.vscdb) and incrementally syncs
 * AI conversations to purmemo. Zero user steps required.
 *
 * Trigger sequence:
 *   1. App startup: catch-up sync for any conversations since lastSyncedAt
 *   2. Cursor loses focus: debounced sync (3s after focus-loss confirmed)
 *
 * Deduplication:
 *   - electron-store tracks lastSyncedAt (ISO) + syncedComposerIds (string[])
 *   - Only composerData entries newer than lastSyncedAt or not in syncedIds are sent
 *   - Backend further deduplicates via conversation_id UPSERT
 *
 * SQLite access:
 *   - Cursor holds a write lock on state.vscdb while running
 *   - We copy to a temp file before reading — safe, fast (<10ms), non-blocking
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import Store from 'electron-store';
import { Notification } from 'electron';

// ── Types ────────────────────────────────────────────────────────────────────

interface CursorSyncState {
  cursorLastSyncedAt: string | null;   // ISO timestamp of last successful sync
  cursorSyncedIds: string[];           // composerIds already sent to backend
  cursorTotalMemories: number;         // cumulative total for tray display
  cursorFirstSyncDone: boolean;        // true after first successful sync notification shown
}

type CursorStore = Store<CursorSyncState & { [key: string]: unknown }>;

interface DBRow {
  key: string;
  value: string;
}

interface SyncResult {
  imported: number;
  skipped: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.purmemo.ai';
const SYNC_DEBOUNCE_MS = 3000;

/** Known Cursor DB paths by platform */
function getCursorDBPath(): string | null {
  switch (process.platform) {
    case 'darwin':
      return path.join(
        os.homedir(),
        'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'
      );
    case 'win32':
      return path.join(
        process.env.APPDATA ?? os.homedir(),
        'Cursor', 'User', 'globalStorage', 'state.vscdb'
      );
    case 'linux':
      return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return null;
  }
}

// ── DB access ────────────────────────────────────────────────────────────────

/**
 * Copy state.vscdb to a temp file and read all cursorDiskKV rows.
 * Copying first avoids SQLite WAL-mode lock conflicts while Cursor is running.
 * Returns null if DB is not found or unreadable.
 */
function readCursorDBRows(): DBRow[] | null {
  const dbPath = getCursorDBPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.log('[cursor-sync] DB not found at', dbPath);
    return null;
  }

  const tmpPath = path.join(os.tmpdir(), `purmemo-cursor-${Date.now()}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
    const db = new Database(tmpPath, { readonly: true, fileMustExist: true });
    try {
      // cursorDiskKV is the KV table — key TEXT, value TEXT
      const rows = db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'"
      ).all() as DBRow[];
      return rows;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[cursor-sync] failed to read DB:', err);
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
  }
}

// ── Incremental filtering ────────────────────────────────────────────────────

/**
 * From all DB rows, extract only composer entries that are new or updated
 * since lastSyncedAt and not already in syncedIds.
 *
 * Returns the full set of rows needed to process those composers
 * (composerData rows + their associated bubbleId rows).
 */
function filterNewRows(
  allRows: DBRow[],
  lastSyncedAt: string | null,
  syncedIds: string[]
): { newRows: DBRow[]; newComposerIds: string[] } {
  const syncedSet = new Set(syncedIds);
  const lastSyncMs = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;

  // Index all rows by key for fast bubbleId lookup
  const rowsByKey = new Map<string, string>();
  for (const row of allRows) {
    rowsByKey.set(row.key, row.value);
  }

  const newComposerIds: string[] = [];
  const neededKeys = new Set<string>();

  for (const row of allRows) {
    if (!row.key.startsWith('composerData:')) continue;

    let composer: { composerId?: string; createdAt?: number; fullConversationHeadersOnly?: unknown[] };
    try {
      composer = JSON.parse(row.value);
    } catch {
      continue;
    }

    const composerId = composer.composerId ?? row.key.split(':')[1];
    if (!composerId) continue;

    // Skip if already synced
    if (syncedSet.has(composerId)) continue;

    // Skip if older than last sync (createdAt is Unix ms)
    const createdMs = composer.createdAt ?? 0;
    if (createdMs > 0 && createdMs <= lastSyncMs) continue;

    // Skip empty conversations
    const headers = composer.fullConversationHeadersOnly;
    if (!Array.isArray(headers) || headers.length === 0) continue;

    newComposerIds.push(composerId);
    neededKeys.add(row.key);

    // Include all associated bubbleId rows
    for (const header of headers) {
      if (header && typeof header === 'object' && 'bubbleId' in header) {
        const bubbleKey = `bubbleId:${composerId}:${(header as { bubbleId: string }).bubbleId}`;
        neededKeys.add(bubbleKey);
      }
    }
  }

  const newRows = allRows.filter(r => neededKeys.has(r.key));
  return { newRows, newComposerIds };
}

// ── Backend sync ─────────────────────────────────────────────────────────────

async function postToCursorDB(token: string, rows: DBRow[]): Promise<SyncResult> {
  const response = await fetch(`${API_BASE}/api/v1/import/cursor-db`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`cursor-db POST failed ${response.status}: ${text}`);
  }

  return await response.json() as SyncResult;
}

// ── Notification ─────────────────────────────────────────────────────────────

function showFirstSyncNotification(count: number): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Purmemo',
    body: `Captured ${count} Cursor conversation${count === 1 ? '' : 's'} — your coding history is now searchable.`,
    silent: false,
  }).show();
}

// ── Core sync function ────────────────────────────────────────────────────────

/**
 * Run one incremental sync cycle.
 * Called on startup and on every Cursor focus-loss event.
 * Returns { imported, skipped } or null if nothing to sync / no DB.
 */
export async function syncCursorHistory(
  getToken: () => Promise<string | null>,
  store: CursorStore,
  onTrayUpdate: () => void
): Promise<SyncResult | null> {
  const token = await getToken();
  if (!token) return null;

  const allRows = readCursorDBRows();
  if (!allRows) return null;

  const lastSyncedAt = store.get('cursorLastSyncedAt', null);
  const syncedIds = store.get('cursorSyncedIds', []);

  const { newRows, newComposerIds } = filterNewRows(allRows, lastSyncedAt, syncedIds);

  if (newComposerIds.length === 0) {
    console.log('[cursor-sync] nothing new to sync');
    return { imported: 0, skipped: 0 };
  }

  console.log(`[cursor-sync] syncing ${newComposerIds.length} new composers (${newRows.length} rows)`);

  try {
    const result = await postToCursorDB(token, newRows);

    // Update state
    const prevTotal = store.get('cursorTotalMemories', 0);
    const firstSyncDone = store.get('cursorFirstSyncDone', false);

    store.set('cursorLastSyncedAt', new Date().toISOString());
    store.set('cursorSyncedIds', [...syncedIds, ...newComposerIds]);
    store.set('cursorTotalMemories', prevTotal + result.imported);

    if (!firstSyncDone && result.imported > 0) {
      store.set('cursorFirstSyncDone', true);
      showFirstSyncNotification(result.imported);
    }

    onTrayUpdate();
    console.log(`[cursor-sync] done: ${result.imported} imported, ${result.skipped} skipped`);
    return result;
  } catch (err) {
    console.warn('[cursor-sync] sync failed:', err);
    return null;
  }
}

// ── Debounced trigger ─────────────────────────────────────────────────────────

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Trigger a debounced sync — called when Cursor loses focus.
 * Waits SYNC_DEBOUNCE_MS before running to avoid firing on quick alt-tabs.
 */
export function triggerCursorSync(
  getToken: () => Promise<string | null>,
  store: CursorStore,
  onTrayUpdate: () => void
): void {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    await syncCursorHistory(getToken, store, onTrayUpdate);
  }, SYNC_DEBOUNCE_MS);
}

// ── Tray helpers ──────────────────────────────────────────────────────────────

/** Returns a human-readable tray label for Cursor sync status. */
export function getCursorTrayLabel(store: CursorStore): string {
  const dbPath = getCursorDBPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    return 'Cursor: not detected';
  }

  const lastSyncedAt = store.get('cursorLastSyncedAt', null);
  const total = store.get('cursorTotalMemories', 0);

  if (!lastSyncedAt) {
    return 'Cursor: syncing…';
  }

  const diffMs = Date.now() - new Date(lastSyncedAt).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const timeAgo = diffMin < 1 ? 'just now' : diffMin === 1 ? '1 min ago' : `${diffMin} min ago`;

  return `Cursor: ${total} memories · synced ${timeAgo}`;
}
