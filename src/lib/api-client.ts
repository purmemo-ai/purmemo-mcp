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

export function initApiClient({ apiUrl, resolveApiKey }) {
  API_URL = apiUrl;
  if (resolveApiKey) _resolveApiKey = resolveApiKey;
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
  if (error.message?.includes('API Error 401') || error.message?.includes('API Error 403')) {
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
// API Call with Circuit Breaker + Timeout
// ============================================================================

// SECURITY: apiKeyOverride allows per-request API key (concurrency-safe)
// instead of mutating a global resolvedApiKey
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
