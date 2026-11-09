// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * What the caller's account gets (2026-11-09).
 *
 * One resolver on purmemo-next decides it (plan + invite grants; next's
 * src/features.js) and serves it at GET /api/v1/features with the caller's own
 * key. This file only CACHES that answer, per key hash, the same way the read
 * routing flag is cached. Next enforces the gates itself, so a stale or wrong
 * cache can show or hide a tool in the list but can never open a gated part.
 *
 * Three answers: an array of feature names (known), or null (UNKNOWN: nothing
 * cached and the lookup failed or is still running). Callers fail closed on
 * unknown for gated tools; the core tools never ask.
 *   - a good answer is kept 10 min; a refresh that fails keeps the last good
 *     answer (up to a day) rather than hiding tools because next blinked;
 *   - with nothing known, a failed lookup is retried after 60 s.
 */
import { createHash } from 'node:crypto';
import { structuredLog } from './logger.js';

export const FEATURES_TTL_MS = 10 * 60 * 1000;
export const FEATURES_NEG_TTL_MS = 60 * 1000;
export const FEATURES_STALE_MAX_MS = 24 * 60 * 60 * 1000;
export const FEATURES_MAX_KEYS = 10000;
export const FEATURES_WAIT_MS = 2000;

/** Where purmemo-next answers: the same base what_changed and session search use. */
export function featuresBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.PURMEMO_NEXT_URL || '').trim();
  const raw = explicit || (env.PURMEMO_READ_BASE_URL || '').trim() || (env.PURMEMO_SESSIONS_URL || '').trim() || 'https://next.purmemo.ai';
  return raw.replace(/\/+$/, '');
}

type Deps = { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number; ttlMs?: number; negTtlMs?: number; userAgent?: string; onEvent?: (e: Record<string, unknown>) => void };

export function createFeaturesCache(deps: Deps = {}) {
  const now = deps.now || Date.now;
  const ttl = deps.ttlMs ?? FEATURES_TTL_MS, negTtl = deps.negTtlMs ?? FEATURES_NEG_TTL_MS;
  const onEvent = deps.onEvent || ((e: Record<string, unknown>) => structuredLog.info('account-features', e));
  // features: string[] (known) | null (unknown). exp: when to ask again. at: when the features were last confirmed.
  const byKey = new Map<string, { features: string[] | null; exp: number; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  const hash = (k: string) => createHash('sha256').update(String(k)).digest('hex');

  function remember(h: string, entry: { features: string[] | null; exp: number; at: number }) {
    if (!byKey.has(h) && byKey.size >= FEATURES_MAX_KEYS) byKey.delete(byKey.keys().next().value as string);
    byKey.set(h, entry);
  }
  async function fetchOnce(key: string, h: string): Promise<void> {
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    const started = now();
    let features: string[] | null = null; let reason = '';
    try {
      const r = await fetchImpl(`${featuresBaseUrl(deps.env)}/api/v1/features`, { headers: { Authorization: `Bearer ${key}`, ...(deps.userAgent ? { 'User-Agent': deps.userAgent } : {}) }, signal: AbortSignal.timeout(5000) });
      const data: any = r.ok ? await r.json().catch(() => null) : null;
      if (Array.isArray(data?.features)) features = data.features.map(String);
      else reason = `features HTTP ${r.status}`;
    } catch (err: any) { reason = `features error: ${err?.message || err}`; }
    if (features) {
      remember(h, { features, exp: now() + ttl, at: now() });
      onEvent({ known: true, count: features.length, ms: now() - started });
      return;
    }
    // Failed: keep the last good answer if it is recent enough; otherwise unknown. Either way, ask again soon.
    const prev = byKey.get(h);
    const keep = prev?.features && now() - prev.at < FEATURES_STALE_MAX_MS ? prev.features : null;
    remember(h, { features: keep, exp: now() + negTtl, at: prev?.at || 0 });
    onEvent({ known: false, kept_last: Boolean(keep), reason, ms: now() - started });
  }
  function refresh(key: string, h: string): Promise<void> {
    let p = inflight.get(h);
    if (!p) { p = fetchOnce(key, h).catch(() => {}).finally(() => inflight.delete(h)); inflight.set(h, p); }
    return p;
  }
  /** What is cached right now: the features, or null when unknown. Starts a background refresh when due. Never waits. */
  function get(key: string): string[] | null {
    if (!key) return null;
    const h = hash(key); const hit = byKey.get(h);
    if (!hit || hit.exp <= now()) refresh(key, h);
    return hit ? hit.features : null;
  }
  /** The features, waiting at most waitMs for a lookup when nothing is known yet (or the answer is due). null = unknown. */
  async function resolve(key: string, waitMs: number = FEATURES_WAIT_MS): Promise<string[] | null> {
    if (!key) return null;
    const h = hash(key); const hit = byKey.get(h);
    if (hit && hit.exp > now()) return hit.features;
    const p = refresh(key, h);
    if (hit?.features) return hit.features; // a known answer that is merely due: use it, refresh in the background
    let timer: any;
    await Promise.race([p, new Promise((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); })]);
    clearTimeout(timer);
    return byKey.get(h)?.features ?? null;
  }
  /** Fire-and-forget warm-up (when a key is validated). */
  function prefetch(key: string): void { if (key) get(key); }
  /** Tests / draining: wait for any lookup in flight. */
  async function settle(): Promise<void> { await Promise.all([...inflight.values()]); }
  return { get, resolve, prefetch, settle, _size: () => byKey.size };
}
