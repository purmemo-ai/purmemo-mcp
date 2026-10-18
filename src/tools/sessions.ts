// @ts-nocheck — typing deferred (matches handlers.ts convention)
/**
 * search_past_sessions — beta (2026-10-18), listed only with PURMEMO_SESSIONS_BETA=1.
 *
 * Searches the raw transcripts of the user's past AI sessions on purmemo-next.
 * Live has no transcripts, so there is no fallback: any failure is explained
 * in plain words and recall_memories is named as what still works.
 */

import { structuredLog } from '../lib/logger.js';
import { makeSessionsCall, sanitizeUnicode, safeErrorMessage } from '../lib/api-client.js';

export const SESSIONS_LIMIT_DEFAULT = 6;
export const SESSIONS_LIMIT_MAX = 12;

/** Factory so tests can inject the transport. */
export function createSearchPastSessions(call = makeSessionsCall) {
  return async function handleSearchPastSessions(args: any) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return { content: [{ type: 'text', text: '❌ search_past_sessions needs a query, e.g. search_past_sessions({ query: "why we moved the database" })' }], isError: true };
    const n = parseInt(String(args?.limit ?? SESSIONS_LIMIT_DEFAULT), 10);
    const limit = Math.min(SESSIONS_LIMIT_MAX, Math.max(1, Number.isFinite(n) ? n : SESSIONS_LIMIT_DEFAULT));
    const started = Date.now();
    try {
      const data = await call('/api/v10/mcp/tools/execute', {
        method: 'POST',
        body: JSON.stringify({ tool: 'search_past_sessions', arguments: { query: sanitizeUnicode(query), limit } })
      });
      structuredLog.info('search_past_sessions: completed', { ms: Date.now() - started, limit });
      if (!data?.content?.length) return { content: [{ type: 'text', text: `No past sessions matched "${query}".` }] };
      return {
        ...data,
        content: data.content.map((c: any) => (c?.type === 'text' ? { ...c, text: sanitizeUnicode(c.text) } : c))
      };
    } catch (err: any) {
      structuredLog.warn('search_past_sessions: failed', { ms: Date.now() - started, status: err?.status ?? null, kind: err?.kind ?? null });
      const why = err?.status === 501 || err?.status === 404
        ? 'the sessions search is not switched on for your account yet'
        : safeErrorMessage(err);
      return { content: [{ type: 'text', text: `⚠️ Could not search your past sessions right now: ${why}\n\nrecall_memories still works for your saved memories.` }], isError: true };
    }
  };
}

export const handleSearchPastSessions = createSearchPastSessions();
