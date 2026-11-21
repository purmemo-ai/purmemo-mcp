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
 * One folder per account: ~/.purmemo/pending/<account>/<client_id>.json. Each capture also records a fingerprint
 * of the sign-in it was made under (never the sign-in itself). It is only ever sent again with that same sign-in:
 * the account's name on this machine can change under a running connector, the fingerprint cannot be confused.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

export const PENDING_RESEND_MAX = 25; // per pass: a long outage is caught up over a few passes, never in one burst
export const TMP_ORPHAN_MS = 60 * 1000;      // a half-finished write older than this was left by a crash

export function pendingRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PURMEMO_PENDING_DIR || '').trim() || join(homedir(), '.purmemo', 'pending');
}
/**
 * A folder name for an account. One account, one folder: every character outside a small safe set is written as
 * its code, so two different names can never share a folder. "default" when this machine has no name for it (an
 * account is named by its address, so none is called that).
 */
export function accountFolder(account: string | null | undefined): string {
  const s = String(account || '').trim().toLowerCase();
  if (!s) return 'default';
  const enc = [...s].map((ch) => (/[a-z0-9@_-]/.test(ch) ? ch : ch === '.' ? '.' : `~${ch.codePointAt(0).toString(16)}~`)).join('');
  return enc.replace(/^\./, '~2e~'); // never '.', '..' or a hidden folder
}
/** A short fingerprint of a sign-in. Never reversible to it, never sent anywhere. */
export function signInFingerprint(key: string | null | undefined): string | null {
  return key ? createHash('sha256').update(`purmemo-pending:${key}`).digest('hex').slice(0, 16) : null;
}
const dirOf = (account, env) => join(pendingRoot(env), accountFolder(account));
const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

// Atomic and private to this writer: a crash leaves the old file or the new one, and two writers never share a
// half-written file.
function writeAtomic(p: string, text: string) {
  const tmp = `${p}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, p);
}

/** Write (or rewrite) one capture. */
export function writePending(account, capture, env: NodeJS.ProcessEnv = process.env): string {
  const dir = dirOf(account, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${safeId(capture.client_id)}.json`);
  writeAtomic(p, JSON.stringify(capture, null, 1));
  return p;
}

// A write that a crash cut off between its two steps left a complete capture under a temporary name. Put it
// in place (unless its capture is already there), so it is counted and sent like any other.
function recoverOrphans(dir: string, now = Date.now()) {
  for (const f of readdirSync(dir)) {
    const m = /^(.+\.json)\.\d+\.[0-9a-f]+\.tmp$/.exec(f);
    if (!m) continue;
    const tmp = join(dir, f);
    try {
      if (now - statSync(tmp).mtimeMs < TMP_ORPHAN_MS) continue; // may still be being written
      const capture = JSON.parse(readFileSync(tmp, 'utf8'));
      if (!capture || !capture.client_id) continue;
      const final = join(dir, m[1]);
      if (existsSync(final)) rmSync(tmp, { force: true }); else renameSync(tmp, final);
    } catch { /* not a whole capture: left where it is, counted as unreadable */ }
  }
}

/**
 * What waits for an account. → { captures (oldest first), unreadable: [file names] }. A file that cannot be read
 * is never dropped and never hidden: it stays on disk and is named here.
 */
export function readPending(account, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const dir = dirOf(account, env);
  const captures = []; const unreadable = [];
  if (!existsSync(dir)) return { captures, unreadable };
  try { recoverOrphans(dir, now); } catch { /* reading goes on */ }
  let names = [];
  try { names = readdirSync(dir); } catch { return { captures, unreadable: ['(the folder itself)'] }; }
  for (const f of names) {
    if (f === 'refused') continue;
    if (!f.endsWith('.json')) { if (f.endsWith('.tmp')) { try { if (now - statSync(join(dir, f)).mtimeMs >= TMP_ORPHAN_MS) unreadable.push(f); } catch { if (existsSync(join(dir, f))) unreadable.push(f); } } continue; }
    try {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (c && c.client_id && c.body) captures.push(c); else unreadable.push(f);
    } catch { if (existsSync(join(dir, f))) unreadable.push(f); } // gone since the folder was listed (sent, or finished by another writer): not a file that cannot be read
  }
  captures.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return { captures, unreadable };
}
/** Is there a write a crash may have cut short, too young to be put back yet? */
export function halfWrittenWaiting(account, env: NodeJS.ProcessEnv = process.env): boolean {
  try { return readdirSync(dirOf(account, env)).some((f) => /\.json\.\d+\.[0-9a-f]+\.tmp$/.test(f)); } catch { return false; }
}
/** The captures waiting for an account, oldest first. */
export function listPending(account, env: NodeJS.ProcessEnv = process.env): any[] {
  return readPending(account, env).captures;
}
/** purmemo answered "saved": the capture leaves the pending folder. */
export function removePending(account, clientId, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(join(dirOf(account, env), `${safeId(clientId)}.json`), { force: true });
}
/** purmemo answered "no": the capture is kept, out of the way, with the reason. Written first, removed second. */
export function refusePending(account, capture, reason: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(dirOf(account, env), 'refused');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${safeId(capture.client_id)}.json`);
  writeAtomic(p, JSON.stringify({ ...capture, refused_at: new Date().toISOString(), refused_because: reason }, null, 1));
  removePending(account, capture.client_id, env);
  return p;
}
/**
 * How many are waiting, how old the oldest is (hours), how many files cannot be read, and how many were captured
 * under a different sign-in than `fingerprint` (those wait for their own sign-in and are not sent with this one).
 */
export function pendingSummary(account, env: NodeJS.ProcessEnv = process.env, now = Date.now(), fingerprint: string | null = null) {
  const { captures, unreadable } = readPending(account, env, now);
  const oldest = captures.length ? Math.max(0, (now - new Date(captures[0].created_at).getTime()) / 3600000) : 0;
  const other = fingerprint ? captures.filter((c) => c.sign_in && c.sign_in !== fingerprint).length : 0;
  return { count: captures.length, oldest_hours: Math.round(oldest * 10) / 10, unreadable: unreadable.length, other_sign_in: other };
}
