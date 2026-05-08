/**
 * Purmemo Hooks — Shared Library (Cross-Platform)
 *
 * Single source of truth for auth, transcript reading, API calls,
 * and state management. All hooks import from here.
 *
 * Supports Claude Code AND Gemini CLI — auto-detects platform from
 * hook_event_name or transcript path. Self-contained: no imports
 * from parent directories. Copied standalone during setup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

// ─── Types (self-contained, no ../types.js imports) ──────────────────────────

export interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  hook_event_name?: string;
  tool_name?: string;
  transcript_path?: string;
  prompt?: string;
  trigger?: string;
}

export interface TranscriptEntry {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  } | string;
  [key: string]: unknown;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Stamped at build time by setup.ts — used for update-notifier pattern */
export const HOOKS_VERSION = '__HOOKS_VERSION__';

const API_URL = process.env.PURMEMO_API_URL || 'https://api.purmemo.ai';

// ─── Platform detection ─────────────────────────────────────────────────────

export type Platform = 'claude' | 'gemini' | 'codex';

// Events that ONLY Gemini CLI uses. SessionStart/SessionEnd are shared with
// Claude Code, so they MUST NOT be here — matching them would mislabel every
// Claude Code SessionEnd/SessionStart invocation as a Gemini session.
const GEMINI_EVENTS = new Set([
  'AfterTool', 'BeforeTool', 'AfterAgent', 'BeforeAgent',
  'PreCompress',
]);

/** Normalize Gemini event names to Claude Code equivalents for internal logic */
const GEMINI_TO_INTERNAL: Record<string, string> = {
  'AfterTool': 'PostToolUse',
  'BeforeTool': 'PreToolUse',
  'AfterAgent': 'Stop',
  'BeforeAgent': 'UserPromptSubmit',
  'PreCompress': 'PreCompact',
  // SessionStart/SessionEnd are identical across platforms — no normalization needed,
  // and they must NOT be keys that trigger the Gemini branch in detectPlatform.
};

const INTERNAL_TO_GEMINI: Record<string, string> = Object.fromEntries(
  Object.entries(GEMINI_TO_INTERNAL).map(([k, v]) => [v, k])
);

let _detectedPlatform: Platform | null = null;

export function detectPlatform(input?: HookInput): Platform {
  if (_detectedPlatform) return _detectedPlatform;
  if (input?.hook_event_name && GEMINI_EVENTS.has(input.hook_event_name)) {
    _detectedPlatform = 'gemini';
  } else if (input?.transcript_path?.startsWith(path.join(os.homedir(), '.gemini') + path.sep)) {
    _detectedPlatform = 'gemini';
  } else if (process.env.MCP_PLATFORM === 'gemini') {
    _detectedPlatform = 'gemini';
  } else if (input?.transcript_path?.startsWith(path.join(os.homedir(), '.codex') + path.sep)) {
    // Codex shares Claude Code's hook event names (SessionStart, PreToolUse,
    // PostToolUse, UserPromptSubmit, Stop) so we can't disambiguate via event
    // name alone — fall back to transcript path or the env var we set in
    // wireCodex (~/.codex/config.toml writes MCP_PLATFORM=codex).
    _detectedPlatform = 'codex';
  } else if (process.env.MCP_PLATFORM === 'codex') {
    _detectedPlatform = 'codex';
  } else {
    _detectedPlatform = 'claude';
  }
  return _detectedPlatform;
}

/** Normalize incoming Gemini event name to internal (Claude Code) name */
export function normalizeEvent(eventName: string): string {
  return GEMINI_TO_INTERNAL[eventName] || eventName;
}

/** Convert internal event name back to platform-specific name */
export function platformEvent(internalName: string, platform: Platform): string {
  if (platform === 'gemini') return INTERNAL_TO_GEMINI[internalName] || internalName;
  return internalName;
}

// ─── Platform-aware paths ────────────────────────────────────────────────────

function getPaths(platform: Platform) {
  if (platform === 'gemini') {
    const dir = path.join(os.homedir(), '.gemini');
    return {
      stateFile: path.join(dir, 'purmemo_state.json'),
      debugLog: path.join(dir, 'purmemo_debug.log'),
    };
  }
  if (platform === 'codex') {
    const dir = path.join(os.homedir(), '.codex');
    return {
      stateFile: path.join(dir, 'purmemo_state.json'),
      debugLog: path.join(dir, 'purmemo_debug.log'),
    };
  }
  const dir = path.join(os.homedir(), '.claude', 'hooks');
  return {
    stateFile: path.join(dir, 'purmemo_state.json'),
    debugLog: path.join(dir, 'purmemo_debug.log'),
  };
}

// Default to claude until platform is detected
let _paths = getPaths('claude');

/** Call after detectPlatform() to switch state/debug paths */
export function initPlatformPaths(platform: Platform): void {
  _paths = getPaths(platform);
}

// ─── Debug logging ───────────────────────────────────────────────────────────

export function dbg(tag: string, msg: string): void {
  try { fs.appendFileSync(_paths.debugLog, `[${new Date().toISOString()}] [${tag}] ${msg}\n`); } catch {}
}

/** Log errors to stderr so Claude Code can surface them. Use sparingly. */
export function errLog(tag: string, msg: string): void {
  dbg(tag, `ERROR: ${msg}`);
  process.stderr.write(`[purmemo:${tag}] ${msg}\n`);
}

// ─── State management ────────────────────────────────────────────────────────

const STATE_KEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function readState(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(_paths.stateFile, 'utf8'));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      errLog('state', `corrupted state file, resetting: ${(e as Error).message}`);
    }
    return {};
  }
}

export function writeState(state: Record<string, unknown>): void {
  try {
    const dir = path.dirname(_paths.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = _paths.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, _paths.stateFile);
  } catch (e: unknown) {
    errLog('state', `write failed: ${(e as Error).message}`);
  }
}

/** Remove stale per-session keys older than 7 days. */
export function pruneState(state: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  const prefixes = ['session_recall_', 'banner_shown_', 'hb_count_', 'cd_', 'stop_', 'precompact_'];
  let pruned = 0;
  for (const key of Object.keys(state)) {
    const isSessionKey = prefixes.some(p => key.startsWith(p));
    if (!isSessionKey) continue;
    const val = state[key];
    if (typeof val === 'number' && val < now - STATE_KEY_MAX_AGE_MS) {
      delete state[key];
      pruned++;
    } else if (typeof val !== 'number') {
      const sessionId = key.replace(/^(session_recall_|banner_shown_|hb_count_|cd_\w+_|stop_|precompact_)/, '');
      const hasRecentActivity = Object.keys(state).some(k =>
        k.endsWith(sessionId) && typeof state[k] === 'number' && (state[k] as number) > now - STATE_KEY_MAX_AGE_MS
      );
      if (!hasRecentActivity) {
        delete state[key];
        pruned++;
      }
    }
  }
  if (pruned > 0) dbg('state', `pruned ${pruned} stale keys (${Object.keys(state).length} remaining)`);
  return state;
}

// ─── Auth ────────────────────────────────────────────────────────────────────
// IMPORTANT: This file is copied standalone into ~/.claude/hooks/ at install
// time and runs without access to node_modules. It cannot import TokenStore.
// The crypto and path-resolution logic below MUST stay byte-identical to
// src/auth/token-store.ts and src/auth/profile-resolver.ts. The contract
// is locked by tests/profile-resolver-contract.test.js — if that test fails,
// the two read paths have drifted and hooks will silently auth as nobody.

const KEY_FILE_NAME = '.encryption-key';

function loadOrCreatePersistedKey(): Buffer {
  const configDir = process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
  const keyFile = path.join(configDir, KEY_FILE_NAME);
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length === 64 && /^[0-9a-f]+$/.test(existing)) {
      return Buffer.from(existing, 'hex');
    }
  } catch { /* fall through to creation */ }

  const fresh = crypto.randomBytes(32);
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      if (process.platform !== 'win32') fs.chmodSync(configDir, 0o700);
    }
    fs.writeFileSync(keyFile, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    // Hook context: stay quiet on persist failure to avoid noisy startup
    // banners. The current process still has a usable key in memory.
    dbg('auth', `failed to persist encryption key: ${(err as Error).message}`);
  }
  return fresh;
}

function deriveLegacyKey(): Buffer {
  const machineId = os.hostname() + os.userInfo().username;
  return crypto.createHash('sha256').update(machineId).digest();
}

function getEncryptionKey(): Buffer {
  return loadOrCreatePersistedKey();
}

/** Mirror of profile-resolver.ts:getActiveTokenFile() — see header note.
 *  Resolution order:
 *    1. PURMEMO_PROFILE env → profiles/<email>.json
 *    2. ~/.purmemo/active pointer → profiles/<email>.json (if file exists)
 *    3. ~/.purmemo/auth.json (legacy fallback)
 */
function isSafeProfileName(name: string): boolean {
  if (!name || name.length > 254) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name);
}
function getActiveTokenFile(): string {
  const configDir = process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
  const legacy = path.join(configDir, 'auth.json');

  const envProfile = (process.env.PURMEMO_PROFILE || '').trim();
  if (envProfile && isSafeProfileName(envProfile)) {
    return path.join(configDir, 'profiles', `${envProfile}.json`);
  }

  try {
    const pointer = fs.readFileSync(path.join(configDir, 'active'), 'utf8').trim();
    if (pointer && isSafeProfileName(pointer)) {
      const target = path.join(configDir, 'profiles', `${pointer}.json`);
      if (fs.existsSync(target)) return target;
    }
  } catch {}

  return legacy;
}

export function loadApiKey(): string | null {
  try {
    const tokenFile = getActiveTokenFile();
    if (!fs.existsSync(tokenFile)) return null;
    const encryptedData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const iv = Buffer.from(encryptedData.iv, 'hex');

    // Try persisted key first.
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(), iv);
      let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return JSON.parse(decrypted).access_token || null;
    } catch { /* fall through to legacy */ }

    // Fall back to legacy hostname-derived key. If it works, re-encrypt the
    // file under the persisted key so the next read takes the fast path.
    try {
      const legacyDecipher = crypto.createDecipheriv('aes-256-cbc', deriveLegacyKey(), iv);
      let decrypted = legacyDecipher.update(encryptedData.data, 'hex', 'utf8');
      decrypted += legacyDecipher.final('utf8');
      const tokenData = JSON.parse(decrypted);

      try {
        const newIv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(), newIv);
        let reEncrypted = cipher.update(JSON.stringify(tokenData), 'utf8', 'hex');
        reEncrypted += cipher.final('hex');
        fs.writeFileSync(
          tokenFile,
          JSON.stringify({ iv: newIv.toString('hex'), data: reEncrypted }, null, 2),
          { encoding: 'utf8', mode: 0o600 }
        );
      } catch (err) {
        dbg('auth', `legacy decrypt ok but re-save failed: ${(err as Error).message}`);
      }

      return tokenData.access_token || null;
    } catch {
      // Both keys failed — file is unrecoverable (ADR-039 hostname drift past
      // the legacy fallback window). Delete it so subsequent reads return
      // null cleanly and the user is routed back through `purmemo init`.
      // Stays silent on stderr — hooks run in stdio context where Claude
      // parses stderr; debug log only.
      try { fs.unlinkSync(tokenFile); } catch { /* best-effort */ }
      dbg('auth', 'token unrecoverable under both persisted and legacy keys; deleted');
      return null;
    }
  } catch { return null; }
}

// ─── Transcript reading ──────────────────────────────────────────────────────

/** Read Claude Code JSONL or Gemini JSON transcript */
export function readTranscript(transcriptPath: string | undefined): TranscriptEntry[] {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
    const raw = fs.readFileSync(transcriptPath, 'utf8').trim();
    if (!raw) return [];

    // Use platform detection (set by detectPlatform() before this runs).
    // JSONL lines also start with '{', so content-sniffing was wrong — it
    // routed every Claude Code transcript to the Gemini JSON parser.
    if (_detectedPlatform === 'gemini') {
      return readGeminiTranscript(raw);
    }

    const lines = raw.split('\n').filter(Boolean);
    return lines.map(line => {
      try { return JSON.parse(line) as TranscriptEntry; } catch { return null; }
    }).filter((e): e is TranscriptEntry => e !== null);
  } catch { return []; }
}

/** Parse Gemini CLI session JSON into TranscriptEntry[] format */
function readGeminiTranscript(raw: string): TranscriptEntry[] {
  try {
    const data = JSON.parse(raw);
    const messages = data.messages || data.turns || [];
    if (!Array.isArray(messages)) return [];

    return messages.map((msg: Record<string, unknown>) => {
      const msgType = (msg.type as string) || (msg.role as string) || '';
      let role: string;
      if (msgType === 'user' || msgType === 'human') role = 'user';
      else if (msgType === 'gemini' || msgType === 'model' || msgType === 'assistant') role = 'assistant';
      else return null;

      // Content can be string or array of {text} objects
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = (content as Array<{ text?: string }>)
          .map(c => c.text || '')
          .join('\n');
      }

      return {
        type: role,
        message: { content: text },
        toolCalls: msg.toolCalls,
      } as TranscriptEntry;
    }).filter((e: TranscriptEntry | null): e is TranscriptEntry => e !== null);
  } catch { return []; }
}

export function extractMessages(entries: TranscriptEntry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    const role: 'user' | 'assistant' | null =
      entry.type === 'user' || entry.type === 'human' ? 'user'
      : entry.type === 'assistant' ? 'assistant'
      : null;
    if (!role) continue;

    const msg = entry.message;
    const text = typeof msg === 'string' ? msg
      : typeof msg?.content === 'string' ? msg.content
      : Array.isArray(msg?.content)
        ? (msg.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join('\n')
      : '';
    if (text.trim()) messages.push({ role, content: text.trim() });
  }
  return messages;
}

export function buildContent(messages: Message[]): string {
  return messages
    .filter(m => m.role && m.content)
    .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

export function apiGet(apiKey: string, urlPath: string, timeout = 8000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const url = new URL(urlPath, API_URL);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode && res.statusCode >= 400) {
            errLog('api', `GET ${urlPath} → ${res.statusCode}: ${body?.error || body?.message || 'unknown'}`);
            resolve(null);
            return;
          }
          resolve(body);
        } catch {
          errLog('api', `GET ${urlPath} → ${res.statusCode} (invalid JSON)`);
          resolve(null);
        }
      });
    });
    req.on('error', (e: Error) => { errLog('api', `GET ${urlPath} → network error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); errLog('api', `GET ${urlPath} → timeout (${timeout}ms)`); resolve(null); });
    req.end();
  });
}

export function apiPost(apiKey: string, urlPath: string, payload: unknown, timeout = 15000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url = new URL(urlPath, API_URL);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode && res.statusCode >= 400) {
            errLog('api', `POST ${urlPath} → ${res.statusCode}: ${parsed?.error || parsed?.message || 'unknown'}`);
            resolve(null);
            return;
          }
          resolve(parsed);
        } catch {
          errLog('api', `POST ${urlPath} → ${res.statusCode} (invalid JSON)`);
          resolve(null);
        }
      });
    });
    req.on('error', (e: Error) => { errLog('api', `POST ${urlPath} → network error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); errLog('api', `POST ${urlPath} → timeout (${timeout}ms)`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Chunked save (for content >90K) ─────────────────────────────────────────

const MAX_CONTENT = 90_000;  // stay under API's 100K Zod limit per chunk
const CHUNK_SIZE  = 20_000;  // match MCP server's chunk size

export function shouldChunk(content: string): boolean {
  return content.length > MAX_CONTENT;
}

function chunkContent(content: string): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < content.length) {
    let end = Math.min(pos + CHUNK_SIZE, content.length);
    if (end < content.length) {
      const searchStart = Math.max(end - 1000, pos);
      const segment = content.slice(searchStart, end);
      const sectionBreak = segment.lastIndexOf('\n===');
      if (sectionBreak !== -1) { end = searchStart + sectionBreak; }
      else {
        const turnBreak = segment.lastIndexOf('\n\nHuman: ');
        if (turnBreak !== -1) { end = searchStart + turnBreak; }
        else {
          const paraBreak = segment.lastIndexOf('\n\n');
          if (paraBreak !== -1) { end = searchStart + paraBreak; }
        }
      }
    }
    chunks.push(content.slice(pos, end));
    pos = end;
  }
  return chunks;
}

export async function saveChunked(
  apiKey: string,
  content: string,
  title: string,
  conversationId: string,
  tags: string[],
  metadata: Record<string, unknown>,
  platform: Platform = 'claude',
): Promise<boolean> {
  const platformName = platform === 'gemini' ? 'gemini' : 'claude-code';
  const chunks = chunkContent(content);
  const totalParts = chunks.length;
  let success = true;

  for (let i = 0; i < chunks.length; i++) {
    const partNumber = i + 1;
    const result = await apiPost(apiKey, '/api/v1/memories/', {
      content: chunks[i],
      title: `${title} (${partNumber}/${totalParts})`,
      conversation_id: `${conversationId}:part:${partNumber}`,
      platform: platformName,
      tags: [...tags, 'chunked-conversation', `session:${conversationId}`],
      metadata: { ...metadata, captureType: 'chunked', partNumber, totalParts, chunkSize: chunks[i].length },
    });
    if (!result?.id && !result?.memory_id) success = false;
  }

  // Create index
  const indexContent = `# ${title} - Index\n\nParts: ${totalParts}\nSize: ${content.length} chars\nSaved: ${new Date().toISOString()}\n\n${chunks.map((c, i) => `- Part ${i + 1}: ${c.length} chars`).join('\n')}`;
  await apiPost(apiKey, '/api/v1/memories/', {
    content: indexContent,
    title: `${title} — Index`,
    conversation_id: `${conversationId}:index`,
    platform: platformName,
    tags: [...tags, 'chunked-conversation'],
    metadata: { ...metadata, captureType: 'index', totalParts },
  });

  return success;
}

// ─── Account/usage snapshot for SessionStart header ────────────────────────
//
// Fetched fresh on every SessionStart — runs in parallel with the memory
// recall, so adds ~0ms to wall-clock time. The whole point of "session start"
// is showing the user a live snapshot: their captures should reflect the
// memory they just saved, their recall counter should be current, their
// tier should reflect the upgrade they did 30 seconds ago. Caching defeats
// that. So we don't.

export interface UsageBucket {
  count: number;
  limit: number;
  unlimited: boolean;
}

export interface AccountSnapshot {
  email: string | null;
  tier: string;             // 'free' | 'pro' | 'teams'
  total_memories: number;
  recalls: UsageBucket;
  workflows: UsageBucket;
  captures: UsageBucket;
  cycle_end: string | null; // ISO-ish date for the "resets May 31" hint
}

/**
 * Fetch tier + usage for the current user. Always live. Returns null on
 * any failure — the SessionStart hook is fire-and-forget; if the snapshot
 * doesn't load, the header just omits the tier/usage lines.
 *
 * Three endpoints, three concerns, fetched in parallel:
 *   /api/v1/auth/me            — email, tier (also returned by /usage)
 *   /api/v1/subscriptions/usage — buckets (recalls/workflows/captures), cycle
 *   /api/v1/stats              — total memories
 */
export async function getAccountSnapshot(apiKey: string): Promise<AccountSnapshot | null> {
  try {
    const [usage, me, stats] = await Promise.all([
      apiGet(apiKey, '/api/v1/subscriptions/usage', 4000),
      apiGet(apiKey, '/api/v1/auth/me', 4000),
      apiGet(apiKey, '/api/v1/stats', 4000).catch(() => null),
    ]);
    if (!usage || !me) return null;

    const u = usage as Record<string, unknown>;
    const m = me as Record<string, unknown>;
    const s = (stats ?? {}) as Record<string, unknown>;

    // /usage wraps buckets under a `usage` key. Read from there, with a
    // top-level fallback in case the API shape ever changes.
    const buckets = (u.usage ?? u) as Record<string, unknown>;

    return {
      email: (m.email as string) ?? null,
      tier: (u.tier as string) ?? 'free',
      total_memories: Number(s.total_memories ?? 0),
      recalls: usageBucket(buckets.recalls),
      workflows: usageBucket(buckets.workflows),
      captures: usageBucket(buckets.captures),
      cycle_end: (u.billing_cycle_end as string) ?? null,
    };
  } catch {
    return null;
  }
}

function usageBucket(raw: unknown): UsageBucket {
  const r = (raw ?? {}) as Record<string, unknown>;
  const limit = Number(r.limit ?? 0);
  return {
    count: Number(r.count ?? 0),
    limit,
    unlimited: Boolean(r.unlimited) || limit === -1,
  };
}

// ─── Version check (update-notifier pattern) ────────────────────────────────

const VERSION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // once per day

function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<string | null> {
  if (HOOKS_VERSION.startsWith('__')) return null; // not stamped (dev mode)
  const state = readState();
  const lastCheck = (state['version_last_check'] as number) || 0;
  if (Date.now() - lastCheck < VERSION_CHECK_INTERVAL) {
    // Return cached result if checked recently
    const cached = state['version_latest'] as string | undefined;
    if (cached && isNewer(cached, HOOKS_VERSION)) return cached;
    return null;
  }

  try {
    const result = await new Promise<string | null>((resolve) => {
      const req = https.request({
        hostname: 'registry.npmjs.org',
        path: '/purmemo-mcp/latest',
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 3000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(data.version || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    if (result) {
      state['version_last_check'] = Date.now();
      state['version_latest'] = result;
      writeState(state);
      if (isNewer(result, HOOKS_VERSION)) return result;
    }
  } catch {}
  return null;
}

// ─── Auto-update hooks ───────────────────────────────────────────────────────

const AUTO_UPDATE_COOLDOWN = 6 * 60 * 60 * 1000; // at most once per 6 hours

/**
 * Auto-update purmemo in the background by running `npx purmemo-mcp@latest
 * --update`. This is the silent universal updater — works for users who
 * installed via `curl … | sh` (have global `purmemo` bin) AND users who
 * installed via `npx purmemo-mcp@latest setup` (no global bin) because npx
 * resolves whether or not the bin is on PATH.
 *
 * `--update` runs the full reconciliation pass introduced in v15.7.5+:
 *   1. Upgrade the npm package itself
 *   2. Refresh hooks if outdated (this file replaces itself)
 *   3. Migrate legacy auth.json → profiles
 *   4. Scrub `export PURMEMO_API_KEY=…` from shell rc files
 *
 * After one hook fire, even old (pre-v15.7) users land on the current shape
 * of the install. Returns true if an update was triggered, false otherwise.
 * Never blocks — fires and forgets with a 30s timeout.
 */
export async function autoUpdateHooks(): Promise<boolean> {
  if (HOOKS_VERSION.startsWith('__')) return false; // dev mode

  const state = readState();
  const lastUpdate = (state['hooks_last_auto_update'] as number) || 0;
  if (Date.now() - lastUpdate < AUTO_UPDATE_COOLDOWN) return false;

  const latest = state['version_latest'] as string | undefined;
  if (!latest || !isNewer(latest, HOOKS_VERSION)) return false;

  dbg('auto-update', `updating hooks ${HOOKS_VERSION} → ${latest}`);
  state['hooks_last_auto_update'] = Date.now();
  writeState(state);

  try {
    const { spawn } = await import('node:child_process');
    const child = spawn('npx', ['-y', 'purmemo-mcp@latest', '--update'], {
      timeout: 30_000,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    child.on('exit', (code) => {
      if (code === 0) dbg('auto-update', 'hooks updated successfully');
      else dbg('auto-update', `exited with code ${code}`);
    });
    return true;
  } catch (err) {
    dbg('auto-update', `spawn failed: ${(err as Error).message}`);
    return false;
  }
}

// ─── Hook stdin reader ───────────────────────────────────────────────────────

export async function readHookInput(): Promise<HookInput | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  return JSON.parse(text) as HookInput;
}
