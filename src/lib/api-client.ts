// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * API client utilities for purmemo MCP server.
 *
 * Exports: sanitizeUnicode, makeApiCall, safeErrorMessage,
 *          CircuitBreaker, CircuitBreakerOpenError, apiCircuitBreaker
 *
 * Call initApiClient({ apiUrl }) before first makeApiCall.
 */

import { structuredLog } from './logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// ============================================================================
// Module state — set via initApiClient()
// ============================================================================

let API_URL = '';
let _resolveApiKey = () => null;
let _userAgent = 'purmemo-mcp/unknown'; // overridden by initApiClient

// Per-request API key stored in AsyncLocalStorage — concurrency-safe.
// Each concurrent request runs in its own async context so keys never bleed
// between users (unlike a plain module-level variable).
const _requestKeyStore = new AsyncLocalStorage<string>();

export function setRequestApiKey(key: string | null) {
  // No-op: callers use runWithApiKey() instead. Kept for backwards compat.
}
export function clearRequestApiKey() {
  // No-op: context exits automatically when the async context ends.
}

// Run fn inside an async context that scopes apiKey to all makeApiCall
// invocations within it (including nested async calls).
export function runWithApiKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return _requestKeyStore.run(key, fn);
}

export function initApiClient({ apiUrl, resolveApiKey, clientVersion, installMethod, platform }) {
  API_URL = apiUrl;
  if (resolveApiKey) _resolveApiKey = resolveApiKey;
  // User-Agent format:
  //   purmemo-mcp/<version> (install=<global|npx|local|unknown>; platform=<...>)
  // Backend parses this to track version distribution per user.
  if (clientVersion) {
    const parts = [];
    if (installMethod) parts.push(`install=${installMethod}`);
    if (platform) parts.push(`platform=${platform}`);
    const tail = parts.length ? ` (${parts.join('; ')})` : '';
    _userAgent = `purmemo-mcp/${clientVersion}${tail}`;
  }
}

// ============================================================================
// Circuit Breaker Pattern
// ============================================================================

export class CircuitBreaker {
  constructor(name, failureThreshold = 5, recoveryTimeout = 60000) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
    this.failureCount = 0;
    this.successCount = 0;
    this.state = 'CLOSED';
    this.openedAt = null;
    this.lastFailureTime = null;
    this.totalCalls = 0;
    this.totalFailures = 0;
  }

  async execute(fn) {
    this.totalCalls++;

    // Check for OPEN → HALF_OPEN transition
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.recoveryTimeout) {
        this.state = 'HALF_OPEN';
        structuredLog.info('Circuit breaker entering HALF_OPEN', { circuit_breaker: this.name });
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    this.successCount++;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      structuredLog.info('Circuit breaker recovered', { circuit_breaker: this.name });
    }
  }

  _onFailure(error) {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      structuredLog.warn('Circuit breaker reopened', { circuit_breaker: this.name, error: error.message });
    } else if (this.failureCount >= this.failureThreshold && this.state === 'CLOSED') {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      structuredLog.error('Circuit breaker opened', { circuit_breaker: this.name, failures: this.failureCount });
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null
    };
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(name) {
    super(`Circuit breaker '${name}' is OPEN. Service temporarily unavailable.`);
    this.name = 'CircuitBreakerOpenError';
    this.circuitBreakerName = name;
  }
}

export const apiCircuitBreaker = new CircuitBreaker('purmemo-api', 5, 60000);

// ============================================================================
// Safe Error Message Helper
// ============================================================================

export function safeErrorMessage(error) {
  if (error.message?.includes('429') || error.message?.includes('quota')) {
    return error.message; // Quota messages are user-facing
  }
  if (error.name === 'AbortError' || error.message?.includes('timeout')) {
    return 'Request timed out. Please try again.';
  }
  if (error instanceof CircuitBreakerOpenError) {
    return 'Service temporarily unavailable. Please try again in a moment.';
  }
  if (error.message?.includes('API Error 401')) {
    return 'Invalid or missing API key.\n\nOption 1 — Easy setup (opens browser):\n  npx purmemo-mcp setup\n\nOption 2 — Manual:\n  claude mcp remove purmemo\n  claude mcp add purmemo -e PURMEMO_API_KEY=your-key -- npx -y purmemo-mcp\n\nGet your key at: https://app.purmemo.ai';
  }
  // Surface api-side detail messages on 4xx (404 / 422 / etc.) instead of
  // hiding them behind the generic fallback. The api returns
  //   { "detail": "<friendly user-facing message>" }
  // for these cases — pull it out so the MCP user sees what actually went wrong.
  const apiErrorMatch = error.message?.match(/^API Error (4\d\d):\s*(.*)$/s);
  if (apiErrorMatch) {
    const status = apiErrorMatch[1];
    const body = apiErrorMatch[2];
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.detail === 'string') {
        return parsed.detail;
      }
    } catch {
      // body wasn't JSON — fall through
    }
    return `API Error ${status}: ${body.slice(0, 300)}`;
  }
  return 'An error occurred while processing your request. Please try again.';
}

// ============================================================================
// Unicode Sanitization
// ============================================================================

/**
 * Removes unpaired surrogates, non-characters, and control characters.
 * Fixes "no low surrogate" errors by removing unpaired surrogates and other invalid chars.
 */
export function sanitizeUnicode(text) {
  if (!text || typeof text !== 'string') return text;

  try {
    // Replace unpaired surrogates with replacement character
    // High surrogates: 0xD800-0xDBFF, Low surrogates: 0xDC00-0xDFFF
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '\uFFFD')
               // Also remove other problematic characters
               .replace(/\uFFFE|\uFFFF/g, '') // Non-characters
               .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Control characters except \n, \r, \t
  } catch (error) {
    structuredLog.error('Error sanitizing text', { error_message: error.message });
    // Fallback: try to encode/decode to fix encoding issues
    try {
      return Buffer.from(text, 'utf8').toString('utf8');
    } catch (fallbackError) {
      structuredLog.error('Fallback sanitization failed, returning empty string', { error_message: fallbackError.message });
      return '';
    }
  }
}

// ============================================================================
// WAF-Safe Memory Payload Encoding
// ============================================================================

/**
 * Wraps a memory POST body so the `content` field is base64-encoded.
 * Render's Cloudflare WAF pattern-matches SQL/HTML keywords in raw request bodies
 * and returns a 403. Base64 encoding is opaque to the WAF; the backend decodes it
 * when content_encoding === "base64".
 */
export function wafSafeBody(payload: Record<string, unknown>): string {
  if (typeof payload.content !== 'string') return JSON.stringify(payload);
  return JSON.stringify({
    ...payload,
    content: Buffer.from(payload.content, 'utf8').toString('base64'),
    content_encoding: 'base64',
  });
}

// ============================================================================
// API Call with Circuit Breaker + Timeout
// ============================================================================

// SECURITY: apiKeyOverride allows per-request API key (concurrency-safe)
// instead of mutating a global resolvedApiKey
/** The credential makeApiCall would use right now (per-request key → resolved key). Used for purmemo-next calls, which accept the same live credential. */
export function getEffectiveApiKey(apiKeyOverride = null) {
  return apiKeyOverride || _requestKeyStore.getStore() || _resolveApiKey();
}

export async function makeApiCall(endpoint, options = {}, apiKeyOverride = null) {
  const method = options.method || 'GET';
  const requestId = `api_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const effectiveKey = apiKeyOverride || _requestKeyStore.getStore() || _resolveApiKey();

  structuredLog.info('API call starting', {
    request_id: requestId,
    method,
    endpoint,
    api_url: API_URL,
    api_key_configured: !!effectiveKey
  });

  if (!effectiveKey) {
    structuredLog.error('No API key configured', { request_id: requestId });
    throw new Error('API Error 401: No API key configured. Run `npx purmemo-mcp setup` to connect, or set PURMEMO_API_KEY.');
  }

  return await apiCircuitBreaker.execute(async () => {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${effectiveKey}`,
          'Content-Type': 'application/json',
          'User-Agent': _userAgent,
          ...options.headers
        }
      });

      clearTimeout(timeoutId);

      structuredLog.debug('API response received', {
        request_id: requestId,
        endpoint,
        status: response.status,
        status_text: response.statusText
      });

      if (!response.ok) {
        const errorText = await response.text();
        structuredLog.warn('API error response', {
          request_id: requestId,
          endpoint,
          status: response.status,
          error_preview: errorText.substring(0, 500)
        });

        // Special handling for quota exceeded (429)
        if (response.status === 429) {
          try {
            const errorData = JSON.parse(errorText);
            // Handle structured error from backend (workflow or recall quota)
            const detail = typeof errorData.detail === 'object' ? errorData.detail : errorData;
            const upgradeUrl = detail.upgrade_url || errorData.upgrade_url || 'https://app.purmemo.ai/dashboard?modal=plans';
            const message = detail.message || errorData.message || 'Monthly quota exceeded';
            const currentUsage = detail.current_usage || errorData.current_usage || '?';
            const limit = detail.limit || errorData.quota_limit || '?';

            const now = new Date();
            const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const resetDateStr = resetDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

            const userMessage = [
              `❌ ${message}`,
              ``,
              `Usage: ${currentUsage}/${limit} this month`,
              ``,
              `🚀 Upgrade to Pro for unlimited access:`,
              `   ${upgradeUrl}`,
              ``,
              `📅 Your quota resets on ${resetDateStr}`,
            ].join('\n');

            throw new Error(userMessage);
          } catch (parseError) {
            if (parseError.message?.includes('Upgrade to Pro')) throw parseError;
            throw new Error(`Monthly quota exceeded. Upgrade to Pro for unlimited access:\nhttps://app.purmemo.ai/dashboard?modal=plans`);
          }
        }

        // WAF 403 — Render's Cloudflare WAF blocks content with SQL/HTML patterns
        if (response.status === 403 && (errorText.includes('<!DOCTYPE') || errorText.includes('Blocked'))) {
          structuredLog.warn('WAF 403 — content triggered Cloudflare security filter', {
            request_id: requestId,
            endpoint,
            content_length: options.body ? String(options.body).length : 0,
          });
          throw new Error(
            'Content contains patterns that triggered security filtering (e.g. SQL keywords or HTML tags). ' +
            'Try rephrasing or removing code snippets that look like SQL commands or script tags.'
          );
        }

        throw new Error(`API Error ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      structuredLog.info('API call successful', {
        request_id: requestId,
        endpoint,
        response_keys: Object.keys(data).length,
        response_size_bytes: JSON.stringify(data).length
      });

      return data;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        structuredLog.error('API request timeout', {
          request_id: requestId,
          endpoint,
          timeout_ms: timeoutMs
        });
        throw new Error('Request timeout after 30 seconds');
      }

      structuredLog.error('API call exception', {
        request_id: requestId,
        endpoint,
        error_name: error.constructor.name,
        error_message: error.message
      });

      throw error;
    }
  });
}

// ---- read-base routing (purmemo-next stage 1, 2026-09-16) ------------------
// When PURMEMO_READ_BASE_URL is set, the READ tools (recall_memories,
// get_memory_details, discover_related_conversations via tools/execute) are
// served by purmemo-next at that base, with the SAME credential; live stays the
// writer and the fallback. Kill switches, both instant and no restart needed:
//   - unset PURMEMO_READ_BASE_URL / set PURMEMO_READ_BASE_DISABLED=1, or
//   - create the file ~/.purmemo/read-base.off (checked on every call).
// Any failure on next (network, 5xx, 501 not-supported / unsupported filter)
// falls back to live and is logged once per call — a bad next answer is never
// worse than live for the user, only slower.
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const READ_BASE_TOOLS = new Set(['recall_memories', 'get_memory_details', 'discover_related_conversations']);
export const READ_BASE_KILL_FILE = join(homedir(), '.purmemo', 'read-base.off');

export function readBaseUrl(env: NodeJS.ProcessEnv = process.env, killFileExists: (p: string) => boolean = existsSync): string | null {
  const raw = (env.PURMEMO_READ_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw || env.PURMEMO_READ_BASE_DISABLED === '1') return null;
  if (killFileExists(READ_BASE_KILL_FILE)) return null;
  return raw;
}

/** Decide whether a tools/execute call is eligible for next: read tool, no live-only filters. */
export function readBaseEligible(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  if (!READ_BASE_TOOLS.has(body.tool)) return false;
  const a = body.arguments || {};
  for (const f of ['intent', 'deadline', 'cluster']) if (a[f] !== undefined && a[f] !== null && a[f] !== '') return false;
  return true;
}

type ReadCallDeps = { fetchImpl?: typeof fetch; fallback?: (endpoint: string, options: any) => Promise<any>; env?: NodeJS.ProcessEnv; killFileExists?: (p: string) => boolean; key?: string | null; onEvent?: (e: Record<string, unknown>) => void };

/** Factory so the routing + fallback logic is testable without the network. */
export function createReadCall(deps: ReadCallDeps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const fallback = deps.fallback || ((endpoint: string, options: any) => makeApiCall(endpoint, options));
  const onEvent = deps.onEvent || ((e: Record<string, unknown>) => structuredLog.info('read-base', e));
  return async function readCall(endpoint: string, options: any = {}) {
    const base = readBaseUrl(deps.env, deps.killFileExists);
    let body: any = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch { body = null; }
    if (!base || !readBaseEligible(body)) return fallback(endpoint, options);
    const key = deps.key !== undefined ? deps.key : getEffectiveApiKey();
    if (!key) return fallback(endpoint, options);
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
      const r = await fetchImpl(`${base}${endpoint}`, { method: options.method || 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': _userAgent, ...(options.headers || {}) }, body: options.body, signal: controller.signal });
      clearTimeout(timer);
      if (!r.ok) {
        const preview = (await r.text().catch(() => '')).slice(0, 200);
        onEvent({ served_by: 'live', reason: `next HTTP ${r.status}`, tool: body.tool, ms: Date.now() - started, preview });
        return fallback(endpoint, options);
      }
      const data = await r.json();
      onEvent({ served_by: 'next', tool: body.tool, ms: Date.now() - started, base });
      return data;
    } catch (err: any) {
      onEvent({ served_by: 'live', reason: `next error: ${err?.message || err}`, tool: body.tool, ms: Date.now() - started });
      return fallback(endpoint, options);
    }
  };
}

/** Default read call used by the read tool handlers. */
export const makeReadCall = createReadCall();
