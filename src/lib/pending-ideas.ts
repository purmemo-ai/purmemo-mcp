// @ts-nocheck — typing deferred (matches handlers.ts convention)
/**
 * The pending file: ideas captured on this device that purmemo has not answered for yet (2026-11-21).
 *
 * An idea must never be lost because purmemo could not be reached, and must never be shown as saved before it
 * is. So a capture is WRITTEN HERE FIRST, then sent. It leaves this folder only by purmemo's own answer:
 *   saved    → the file is removed
 *   refused  → the file is MOVED to refused/ beside it, with the reason (nothing is deleted)
 *   anything else (no network, timeout, 5xx, sign-in or plan not confirmed) → it stays, and is sent again
 * Every capture carries an id chosen here (client_id), so sending it twice can never make a second idea.
 *
 * One folder per account: ~/.purmemo/pending/<account>/<client_id>.json. A capture belongs to the account it was
 * made for and is only ever sent with that account's sign-in. bauhaus uses the same folder through this code.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PENDING_RESEND_MAX = 25; // per pass: a long outage is caught up over a few passes, never in one burst

export function pendingRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PURMEMO_PENDING_DIR || '').trim() || join(homedir(), '.purmemo', 'pending');
}
/** A folder-safe name for an account ("default" when this machine has one account and no label for it). */
export function accountFolder(account: string | null | undefined): string {
  const s = String(account || '').trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, '_').replace(/^\.+/, '_');
  return s || 'default';
}
const dirOf = (account, env) => join(pendingRoot(env), accountFolder(account));
const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

/** Write (or rewrite) one capture. Atomic: a crash leaves the old file or the new one, never half of one. */
export function writePending(account, capture, env: NodeJS.ProcessEnv = process.env): string {
  const dir = dirOf(account, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${safeId(capture.client_id)}.json`);
  writeFileSync(`${p}.tmp`, JSON.stringify(capture, null, 1), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  return p;
}
/** The captures waiting for an account, oldest first. A file that does not read is left where it is and skipped. */
export function listPending(account, env: NodeJS.ProcessEnv = process.env): any[] {
  const dir = dirOf(account, env);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* unreadable: kept on disk, not sent */ }
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
/** purmemo answered "saved": the capture leaves the pending folder. */
export function removePending(account, clientId, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(join(dirOf(account, env), `${safeId(clientId)}.json`), { force: true });
}
/** purmemo answered "no": the capture is kept, out of the way, with the reason. */
export function refusePending(account, capture, reason: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(dirOf(account, env), 'refused');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${safeId(capture.client_id)}.json`);
  writeFileSync(`${p}.tmp`, JSON.stringify({ ...capture, refused_at: new Date().toISOString(), refused_because: reason }, null, 1), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  removePending(account, capture.client_id, env);
  return p;
}
/** How many are waiting, and how old the oldest is (hours). */
export function pendingSummary(account, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const list = listPending(account, env);
  const oldest = list.length ? Math.max(0, (now - new Date(list[0].created_at).getTime()) / 3600000) : 0;
  return { count: list.length, oldest_hours: Math.round(oldest * 10) / 10 };
}
