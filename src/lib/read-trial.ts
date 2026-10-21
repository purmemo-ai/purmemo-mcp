// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * Trial count for next-served reads (2026-10-21).
 *
 * Every read the read-base switch routes (served by next, or fell back to live
 * and why) is appended as one JSON line to a local file. Counts only: when, mode
 * (hosted/local), the first 8 characters of the account id, the tool, who served
 * it, a short fallback reason, milliseconds. Never the query, never memory text.
 * Unlisted accounts are never recorded (they never reach the switch).
 *
 *   files:   PURMEMO_READ_TRIAL_LOG (default ~/.purmemo/read-trial.jsonl) names the base; lines go to
 *            <base>.<YYYY-MM-DD>.jsonl, one file per UTC day, pruned after PURMEMO_READ_TRIAL_KEEP_DAYS (30).
 *   summary: `purmemo-mcp-setup trial [--days 7]` → one line per day, counts only.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

export const READ_TRIAL_FILE = join(homedir(), '.purmemo', 'read-trial.jsonl');
export const READ_TRIAL_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

/** The base path: PURMEMO_READ_TRIAL_LOG or ~/.purmemo/read-trial.jsonl. Lines go to <base minus .jsonl>.<YYYY-MM-DD>.jsonl. */
export function readTrialFile(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PURMEMO_READ_TRIAL_LOG || '').trim() || READ_TRIAL_FILE;
}
const stem = (base: string) => base.replace(/\.jsonl$/, '');
/** Today's file for a base path: one file per UTC day, so the log is bounded by retention, never by luck. */
export function trialFileFor(base: string, now: () => number = Date.now): string {
  return `${stem(base)}.${new Date(now()).toISOString().slice(0, 10)}.jsonl`;
}
export function keepDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PURMEMO_READ_TRIAL_KEEP_DAYS); return Number.isFinite(n) && n > 0 ? Math.floor(n) : READ_TRIAL_KEEP_DAYS;
}
/** Every dated file for a base path (plus the legacy undated file if present), oldest first. */
export function trialFiles(base: string): string[] {
  const dir = dirname(base), prefix = basename(stem(base)) + '.';
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const dated = names.filter((n) => n.startsWith(prefix) && /\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().map((n) => join(dir, n));
  return names.includes(basename(base)) ? [base, ...dated] : dated;
}
/** Delete dated files older than keep days. Called from recordReadTrial at most once an hour; errors swallowed. */
export function pruneTrialFiles(base: string, keep: number, now: () => number = Date.now): string[] {
  const cutoff = new Date(now() - keep * DAY_MS).toISOString().slice(0, 10);
  const gone: string[] = [];
  for (const f of trialFiles(base)) {
    const m = /\.(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && m[1] < cutoff) { try { unlinkSync(f); gone.push(f); } catch { /* ignore */ } }
  }
  return gone;
}
let _lastPrune = 0;

/** First 8 characters of an account id, or 'local' when the mode has no account. */
export function shortAccount(id: unknown, mode: unknown = 'local'): string {
  const s = id === undefined || id === null ? '' : String(id).trim();
  return s ? s.slice(0, 8) : (mode === 'hosted' ? 'unknown' : 'local');
}

/** A fallback reason reduced to a few fixed words — no bodies, no previews. */
export function normalizeReason(reason: unknown): string | null {
  if (!reason) return null;
  const r = String(reason);
  if (/abort|timeout|timed out/i.test(r)) return 'timeout';
  const m = r.match(/HTTP (\d{3})/);
  if (m) return `HTTP ${m[1]}`;
  if (/^next error/i.test(r)) return 'error';
  return r.slice(0, 40);
}

/** The one line recorded per routed read. Only these fields, ever. */
export function trialLine(e: Record<string, unknown>, now: () => number = Date.now) {
  const line: Record<string, unknown> = {
    ts: new Date(now()).toISOString(),
    mode: e.mode || 'local',
    account: shortAccount(e.account, e.mode),
    tool: e.tool || null,
    served_by: e.served_by || null,
    ms: Number.isFinite(e.ms) ? e.ms : null,
  };
  const reason = normalizeReason(e.reason);
  if (reason) line.reason = reason;
  return line;
}

type RecordDeps = { file?: string; env?: NodeJS.ProcessEnv; append?: (file: string, text: string) => void; now?: () => number; prune?: boolean };

/** Append one line to today's file; prune old files at most once an hour. Any failure is swallowed — counting must never break a read. */
export function recordReadTrial(e: Record<string, unknown>, deps: RecordDeps = {}): void {
  try {
    const now = deps.now || Date.now;
    const base = deps.file || readTrialFile(deps.env);
    const file = trialFileFor(base, now);
    const append = deps.append || ((f: string, t: string) => { mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, t); });
    append(file, JSON.stringify(trialLine(e, now)) + '\n');
    if (deps.prune !== false && now() - _lastPrune > 3_600_000) { _lastPrune = now(); pruneTrialFiles(base, keepDays(deps.env), now); }
  } catch { /* never throw into a read */ }
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

type SummaryDeps = { file?: string; env?: NodeJS.ProcessEnv; text?: string; days?: number; now?: () => number };

/** Counts per UTC day over the last `days` days. Reads only the fields trialLine writes. */
export function summarizeReadTrial(deps: SummaryDeps = {}) {
  const days = Math.max(1, Math.floor(deps.days || 7));
  const now = (deps.now || Date.now)();
  const since = now - days * 86_400_000;
  const file = deps.file || readTrialFile(deps.env);
  let text = deps.text;
  if (text === undefined) { text = trialFiles(file).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n'); }
  const perDay = new Map<string, any>();
  let total = 0, bad = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let e: any; try { e = JSON.parse(raw); } catch { bad++; continue; }
    const t = Date.parse(e.ts); if (!Number.isFinite(t) || t < since || t > now + 60_000) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    const d = perDay.get(day) || { day, total: 0, next: 0, live: 0, reasons: {}, nextMs: [], accounts: new Set(), tools: {}, modes: {} };
    d.total++; total++;
    if (e.served_by === 'next') { d.next++; if (Number.isFinite(e.ms)) d.nextMs.push(e.ms); }
    else { d.live++; const r = e.reason || 'unknown'; d.reasons[r] = (d.reasons[r] || 0) + 1; }
    if (e.account) d.accounts.add(e.account);
    if (e.tool) d.tools[e.tool] = (d.tools[e.tool] || 0) + 1;
    if (e.mode) d.modes[e.mode] = (d.modes[e.mode] || 0) + 1;
    perDay.set(day, d);
  }
  const rows = [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => {
    const sorted = d.nextMs.slice().sort((a: number, b: number) => a - b);
    return { day: d.day, total: d.total, next: d.next, live: d.live, reasons: d.reasons, tools: d.tools, modes: d.modes,
      accounts: d.accounts.size, next_p50_ms: percentile(sorted, 50), next_p95_ms: percentile(sorted, 95) };
  });
  return { file, days, total, unparsable: bad, perDay: rows };
}

const secs = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);

/** One line per day, counts only. */
export function formatReadTrialSummary(s: ReturnType<typeof summarizeReadTrial>): string {
  if (!s.perDay.length) return `No routed reads in the last ${s.days} day(s). (file: ${s.file})`;
  const lines = s.perDay.map((d) => {
    const pct = d.total ? Math.round((100 * d.next) / d.total) : 0;
    const reasons = Object.entries(d.reasons).map(([k, v]) => `${k} ×${v}`).join(', ');
    const modes = Object.entries(d.modes).map(([k, v]) => `${k} ${v}`).join(', ');
    return `${d.day}  ${d.total} reads · next ${d.next} (${pct}%) · live ${d.live}${reasons ? ` (${reasons})` : ''} · next p50 ${secs(d.next_p50_ms)}, p95 ${secs(d.next_p95_ms)} · ${d.accounts} account${d.accounts === 1 ? '' : 's'}${modes ? ` · ${modes}` : ''}`;
  });
  lines.push(`${s.total} routed reads in the last ${s.days} day(s). (file: ${s.file})`);
  return lines.join('\n');
}
