// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * Remote HTTP/SSE server for purmemo MCP.
 * Extracted from server.ts — Express + Streamable HTTP + SSE + OAuth.
 *
 * Call startRemoteServer(ctx) to start the remote Express server.
 */

import { structuredLog } from '../lib/logger.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { apiCircuitBreaker, runWithApiKey } from '../lib/api-client.js';
import {
  handleSaveConversation,
  handleSaveArtifact,
  handleCommit,
  handleSnapshot,
  handleGetUserContext,
  handleRunWorkflow,
  handleListWorkflows,
  handleShareMemory,
  handleRecallPublic,
  handleGetPublicMemory,
  handleReportMemory,
  handleGetAcknowledgedErrors,
  handleSaveTestResult,
  handleGetTestResults,
  handleGetArtifacts,
  handleGetInvestigations,
  handleGetNextTask,
  handleSnapshotSources,
  handleSaveSnapshot,
  handleGetSnapshot,
  handleAcceptSnapshot,
  handleCompleteTask,
  handleSaveInvestigation
} from '../tools/handlers.js';
import { handleGenerateHandoffBrief } from '../tools/handoff.js';
import { saveRefreshToken, loadRefreshToken, deleteRefreshToken } from './refresh-token-store.js';
import { reportIncident } from '../lib/incident-reporter.js';

export async function startRemoteServer(ctx) {
  // Destructure all server.ts dependencies — same variable names, zero body changes
  const {
    API_URL,
    CLIENT_VERSION,
    PLATFORM,
    TOOLS,
    RESOURCES,
    RESOURCE_TEMPLATES,
    PROMPTS,
    server,
    getResolvedApiKey,
    setResolvedApiKey,
    resolveApiKey,
    checkForUpdates
  } = ctx;

  // Alias for code that reads resolvedApiKey directly
  let resolvedApiKey = getResolvedApiKey();

  // Structured User-Agent for telemetry (matches CLI format, see auth.ts recordClientPing).
  // install=remote because this process runs as the Render-hosted remote MCP server;
  // platform=mcp-server because it brokers between Claude.ai (and other web MCP clients) and the API.
  const USER_AGENT = `purmemo-mcp/${CLIENT_VERSION} (install=remote; platform=mcp-server)`;

  // ========================================================================
  // REMOTE MODE — Express + Streamable HTTP + SSE (replaces Python server)
  // ========================================================================
  const { default: express } = await import('express');
  const { randomUUID } = await import('node:crypto');

  const app = express();
  app.use(express.json());

  // CORS — allow known MCP client origins only
  const TRUSTED_MCP_ORIGINS = [
    'https://claude.ai', 'https://chat.openai.com', 'https://chatgpt.com',
    'https://gemini.google.com', 'https://app.purmemo.ai', 'https://purmemo.ai',
    'https://api.purmemo.ai', 'http://localhost:3000', 'http://localhost:3001',
    'https://www.figma.com', 'https://figma.com',
  ];
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && TRUSTED_MCP_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Session/transport management
  const transports = {};
  const startTime = Date.now();
  let connectionCount = 0;
  let toolCallCounts = {};
  let recentErrors = []; // last 100 errors

  // Connection monitoring
  const { ConnectionMonitor } = await import('./connection-monitor.js');
  const connMonitor = new ConnectionMonitor(100);
  connMonitor.start();

  // Health endpoint
  app.get('/health', async (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);
    const secs = uptimeSeconds % 60;

    let backendStatus = 'unknown';
    let backendLatency = null;
    try {
      const t0 = Date.now();
      const resp = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) });
      backendLatency = Date.now() - t0;
      backendStatus = resp.ok ? 'healthy' : 'unhealthy';
    } catch { backendStatus = 'unreachable'; }

    const mem = process.memoryUsage();

    res.json({
      status: 'healthy',
      version: CLIENT_VERSION,
      timestamp: new Date().toISOString(),
      active_connections: Object.keys(transports).length,
      metrics: {
        memory_usage_mb: Math.round(mem.rss / 1048576 * 10) / 10,
        heap_used_mb: Math.round(mem.heapUsed / 1048576 * 10) / 10,
        uptime_seconds: uptimeSeconds,
        uptime_human: `${hours}h ${mins}m ${secs}s`,
        total_connections: connectionCount
      },
      tool_usage: toolCallCounts,
      performance: {
        error_rate_percent: 0,
        total_errors: recentErrors.length,
        recent_errors: recentErrors.slice(-5)
      },
      backend_api: {
        url: API_URL,
        status: backendStatus,
        latency_ms: backendLatency
      },
      circuit_breaker: {
        state: apiCircuitBreaker.state,
        consecutive_failures: apiCircuitBreaker.failureCount
      },
      service_info: {
        version: CLIENT_VERSION,
        runtime: 'node',
        api_backend: API_URL,
        environment: process.env.NODE_ENV || 'production',
        capabilities: ['tools', 'resources', 'prompts', 'streamable-http', 'sse']
      }
    });
  });

  // ── Metrics endpoint ──
  app.get('/mcp/metrics', (req, res) => {
    res.json({
      timestamp: new Date().toISOString(),
      ...connMonitor.getMetrics(),
      tool_usage: toolCallCounts,
      summary: connMonitor.getSummary()
    });
  });

  // ── Custom Streamable HTTP handler (mirrors Python main.py POST /mcp/messages) ──
  // NOT using MCP SDK transport — custom handler for ChatGPT widget compatibility

  // Streamable HTTP sessions
  const mcpSessions = new Map();
  const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-11-05', '2025-03-26']);

  // Session cleanup — remove stale sessions every 5 minutes (matches Python)
  const sessionCleanupInterval = setInterval(() => {
    const maxAge = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    let cleaned = 0;
    for (const [sid, sess] of mcpSessions) {
      if (now - sess.lastActivity > maxAge) {
        mcpSessions.delete(sid);
        cleaned++;
      }
    }
    if (cleaned > 0) structuredLog.info('Cleaned up stale sessions', { count: cleaned });
  }, 5 * 60 * 1000);

  // Helper: validate API key from Authorization header
  async function validateApiKeyFromRequest(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.split(' ')[1];
    try {
      const resp = await fetch(`${API_URL}/api/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) return token;
      // Silent token refresh if 401 and we have a refresh token.
      // Cache MISS in-memory → fall back to durable DB store (survives restarts).
      if (resp.status === 401) {
        let refreshToken = refreshTokenStore[token]?.token;
        if (!refreshToken) {
          const persisted = await loadRefreshToken(token);
          if (persisted) {
            refreshToken = persisted;
            // Re-hydrate the in-memory cache so subsequent calls are fast.
            refreshTokenStore[token] = { token: persisted, createdAt: Date.now() };
          }
        }
        if (refreshToken) {
          try {
            const refreshResp = await fetch(`${API_URL}/api/v1/auth/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh_token: refreshToken }),
              signal: AbortSignal.timeout(10000)
            });
            if (refreshResp.ok) {
              const data = await refreshResp.json();
              const newToken = data.access_token || data.api_key;
              if (newToken) {
                if (data.refresh_token) {
                  refreshTokenStore[newToken] = { token: data.refresh_token, createdAt: Date.now() };
                  // Persist alongside the in-memory write so a restart can't lose it.
                  await saveRefreshToken(newToken, data.refresh_token);
                }
                delete refreshTokenStore[token];
                // Drop the old persisted row too — its token was rotated upstream.
                await deleteRefreshToken(token);
                return newToken;
              }
            }
          } catch {}
        }
      }
      return null;
    } catch { return null; }
  }

  // Helper: SSE response
  function sendSSE(res, data) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS_HEADERS
    });
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end();
  }

  // SECURITY: No wildcard CORS — reflect only trusted origins
  const STREAMABLE_TRUSTED_ORIGINS = [
    'https://claude.ai', 'https://chat.openai.com', 'https://chatgpt.com',
    'https://gemini.google.com', 'https://app.purmemo.ai',
    'https://www.figma.com', 'https://figma.com',
  ];
  function getCorsHeaders(req) {
    const origin = req?.headers?.origin;
    const allowOrigin = (origin && STREAMABLE_TRUSTED_ORIGINS.includes(origin)) ? origin : STREAMABLE_TRUSTED_ORIGINS[0];
    return {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    };
  }
  const CORS_HEADERS = getCorsHeaders(null);

  // Helper: JSON response with CORS
  function sendJSON(res, data, statusCode = 200, extraHeaders = {}) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders
    });
    res.end(JSON.stringify(data));
  }

  // Helper: execute a tool call (proxies to backend or handles locally)
  async function executeToolForRemote(toolName, toolArgs, apiKey) {
    // Track tool usage
    toolCallCounts[toolName] = (toolCallCounts[toolName] || 0) + 1;

    // Tools that MUST be handled locally (not available on backend)
    const localOnlyHandlers = {
      'get_user_context': handleGetUserContext,
      'run_workflow': handleRunWorkflow,
      'list_workflows': handleListWorkflows,
      'save_conversation': handleSaveConversation, // local for tag preservation + validation parity
      'save_artifact': handleSaveArtifact,
      'commit': handleCommit,
      'snapshot': handleSnapshot,
      'share_memory': handleShareMemory,
      'recall_public': handleRecallPublic,
      'get_public_memory': handleGetPublicMemory,
      'report_memory': handleReportMemory,
      'generate_handoff_brief': handleGenerateHandoffBrief,
      'get_acknowledged_errors': handleGetAcknowledgedErrors,
      'save_test_result': handleSaveTestResult,
      'get_test_results': handleGetTestResults,
      'get_artifacts': handleGetArtifacts,
      'get_investigations': handleGetInvestigations,
      'get_next_task': handleGetNextTask,
      'complete_task': handleCompleteTask,
      'save_investigation_result': handleSaveInvestigation,
      'snapshot_sources': handleSnapshotSources,
      'save_snapshot': handleSaveSnapshot,
      'get_snapshot': handleGetSnapshot,
      'accept_snapshot': handleAcceptSnapshot,
    };

    const localHandler = localOnlyHandlers[toolName];
    if (localHandler) {
      const effectiveKey = apiKey || resolvedApiKey;
      try {
        // runWithApiKey scopes the key to this async context via AsyncLocalStorage —
        // concurrent requests from different users never bleed into each other.
        return await runWithApiKey(effectiveKey, () => localHandler(toolArgs));
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }

    // recall_memories, get_memory_details, discover_related_conversations
    // proxy to backend — ChatGPT widgets parse the backend's response format
    try {
      const resp = await fetch(`${API_URL}/api/v10/mcp/tools/execute`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-MCP-Version': CLIENT_VERSION
        },
        body: JSON.stringify({ tool: toolName, arguments: toolArgs }),
        signal: AbortSignal.timeout(30000)
      });

      if (resp.status === 401) {
        // Silent token refresh — try refreshing before telling user to reconnect.
        // Cache MISS in-memory → fall back to durable DB store (survives restarts).
        let refreshTokenForRetry = refreshTokenStore[apiKey]?.token;
        if (!refreshTokenForRetry) {
          const persisted = await loadRefreshToken(apiKey);
          if (persisted) {
            refreshTokenForRetry = persisted;
            refreshTokenStore[apiKey] = { token: persisted, createdAt: Date.now() };
          }
        }
        if (refreshTokenForRetry) {
          try {
            const refreshResp = await fetch(`${API_URL}/api/v1/auth/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh_token: refreshTokenForRetry }),
              signal: AbortSignal.timeout(10000)
            });
            if (refreshResp.ok) {
              const refreshData = await refreshResp.json();
              const newToken = refreshData.access_token || refreshData.api_key;
              if (newToken) {
                if (refreshData.refresh_token) {
                  refreshTokenStore[newToken] = { token: refreshData.refresh_token, createdAt: Date.now() };
                  await saveRefreshToken(newToken, refreshData.refresh_token);
                }
                delete refreshTokenStore[apiKey];
                await deleteRefreshToken(apiKey);
                // Retry the tool call with new token
                const retryResp = await fetch(`${API_URL}/api/v10/mcp/tools/execute`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${newToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': USER_AGENT
                  },
                  body: JSON.stringify({ tool: toolName, arguments: toolArgs }),
                  signal: AbortSignal.timeout(30000)
                });
                if (retryResp.ok) {
                  structuredLog.info('Silent token refresh succeeded', { tool: toolName });
                  return await retryResp.json();
                }
              }
            }
          } catch (e) {
            structuredLog.warn('Silent token refresh failed', { error: e.message });
          }
        }
        return {
          isError: true,
          content: [{ type: 'text', text: 'Session expired. Please reconnect via Settings → Connectors → purmemo → Uninstall then re-add.' }]
        };
      }

      if (resp.status === 429) {
        try {
          const errorData = await resp.json();
          const detail = typeof errorData.detail === 'object' ? errorData.detail : errorData;
          const upgradeUrl = detail.upgrade_url || 'https://app.purmemo.ai/dashboard?modal=plans';
          const message = detail.message || 'Monthly quota exceeded';
          const usage = detail.current_usage || '?';
          const limit = detail.limit || detail.quota_limit || '?';
          const now = new Date();
          const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          const resetStr = resetDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          return {
            isError: true,
            content: [{ type: 'text', text: `${message}\n\nUsage: ${usage}/${limit} this month\n\nUpgrade to Pro: ${upgradeUrl}\n\nResets on ${resetStr}` }]
          };
        } catch {
          return { isError: true, content: [{ type: 'text', text: 'Monthly quota exceeded. Upgrade at https://app.purmemo.ai/dashboard?modal=plans' }] };
        }
      }

      if (!resp.ok) {
        const errText = await resp.text();
        recentErrors.push({ timestamp: new Date().toISOString(), tool: toolName, status: resp.status, error: errText.substring(0, 200) });
        if (recentErrors.length > 100) recentErrors.shift();
        // Observability stitch (3b): the restart-volatile recentErrors array
        // hid the get_artifacts 422 bug — errors now ALSO land in the durable
        // incident hub (source=mcp). Reporter skips 401/403/429 noise itself.
        reportIncident(`API error ${resp.status}: ${errText.substring(0, 200)}`, { tool: toolName, status: resp.status });
        return { error: `API error ${resp.status}: ${errText.substring(0, 200)}` };
      }

      const data = await resp.json();
      return data;
    } catch (e) {
      recentErrors.push({ timestamp: new Date().toISOString(), tool: toolName, error: e.message });
      if (recentErrors.length > 100) recentErrors.shift();
      reportIncident(e.message, { tool: toolName, component: 'tool-execution' });
      return { error: e.name === 'AbortError' ? 'Request timeout' : e.message };
    }
  }

  // ── CORS preflight ──
  app.options('/mcp/messages', (req, res) => {
    res.writeHead(204, CORS_HEADERS);
    res.end();
  });


  // ── POST /mcp/messages — main Streamable HTTP dispatch ──
  app.post('/mcp/messages', async (req, res) => {
    try {
      const body = req.body;
      const method = body?.method;
      const requestId = body?.id;

      // ── initialize ──
      if (method === 'initialize') {
        const apiKey = await validateApiKeyFromRequest(req);
        if (!apiKey) {
          return sendJSON(res, {
            jsonrpc: '2.0', id: requestId,
            error: { code: -32001, message: 'Authentication required', data: { type: 'authorization_required' } }
          }, 401, {
            'WWW-Authenticate': `Bearer resource_metadata="https://${req.get('host')}/.well-known/oauth-protected-resource"`
          });
        }
        const sessionId = randomUUID();
        mcpSessions.set(sessionId, { token: apiKey, createdAt: Date.now(), lastActivity: Date.now() });
        connectionCount++;
        connMonitor.trackConnection(sessionId, { type: 'streamable-http' });

        const clientVersion = body?.params?.protocolVersion || '2025-03-26';
        const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.has(clientVersion) ? clientVersion : '2024-11-05';

        return sendJSON(res, {
          jsonrpc: '2.0', id: requestId,
          result: {
            protocolVersion: negotiatedVersion,
            capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false }, logging: {} },
            serverInfo: { name: 'purmemo-mcp', version: CLIENT_VERSION },
            instructions: 'pūrmemo tools are ready. Save memories, recall information, and run memory-powered workflows.'
          }
        }, 200, { 'Mcp-Session-Id': sessionId });
      }

      // ── notifications/initialized ──
      if (method === 'notifications/initialized') {
        return res.status(200).end();
      }

      // ── ping ──
      if (method === 'ping') {
        return sendJSON(res, { jsonrpc: '2.0', id: requestId, result: {} });
      }

      // ── tools/list (PUBLIC — no auth required) ──
      if (method === 'tools/list') {
        return sendJSON(res, { jsonrpc: '2.0', id: requestId, result: { tools: TOOLS } });
      }

      // ── Auth required for remaining methods ──
      const sessionId = req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];
      let apiKey = null;
      if (sessionId && mcpSessions.has(sessionId)) {
        apiKey = mcpSessions.get(sessionId).token;
        mcpSessions.get(sessionId).lastActivity = Date.now();
      } else {
        apiKey = await validateApiKeyFromRequest(req);
      }

      if (!apiKey) {
        return sendJSON(res, {
          jsonrpc: '2.0', id: requestId,
          error: { code: -32001, message: 'Authentication required' }
        }, 401, CORS_HEADERS);
      }

      // ── resources/list ──
      if (method === 'resources/list') {
        return sendJSON(res, {
          jsonrpc: '2.0', id: requestId,
          result: { resources: RESOURCES, resourceTemplates: RESOURCE_TEMPLATES }
        });
      }

      // ── resources/read ──
      if (method === 'resources/read') {
        const uri = body?.params?.uri || '';

        // Widget resources — return HTML directly as JSON (NOT SSE)
        const widgetFiles = {
          'ui://widgets/recall-v39.html': 'recall.html',
          'ui://widgets/save.html': 'save.html',
          'ui://widgets/memory-detail.html': 'memory-detail.html',
          'ui://widgets/context.html': 'context.html',
          'ui://widgets/discover.html': 'discover.html'
        };
        if (widgetFiles[uri]) {
          const { readFileSync: rfs } = await import('node:fs');
          const { dirname: dn, join: jn } = await import('node:path');
          const { fileURLToPath: fu } = await import('node:url');
          const html = rfs(jn(dn(fu(import.meta.url)), 'widgets', widgetFiles[uri]), 'utf8');
          return sendJSON(res, {
            jsonrpc: '2.0', id: requestId,
            result: { contents: [{ uri, mimeType: 'text/html+skybridge', text: html }] }
          });
        }

        // Memory resources — proxy to backend
        try {
          const authHeaders = { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': USER_AGENT };
          let text = '', mimeType = 'text/plain';

          if (uri === 'memory://me') {
            const [meResp, statsResp, memsResp, sessResp] = await Promise.allSettled([
              fetch(`${API_URL}/api/v1/auth/me`, { headers: authHeaders, signal: AbortSignal.timeout(10000) }),
              fetch(`${API_URL}/api/v1/stats/`, { headers: authHeaders, signal: AbortSignal.timeout(10000) }),
              fetch(`${API_URL}/api/v1/memories/?limit=20&sort=created_at&order=desc`, { headers: authHeaders, signal: AbortSignal.timeout(10000) }),
              fetch(`${API_URL}/api/v1/identity/session`, { headers: authHeaders, signal: AbortSignal.timeout(10000) })
            ]);
            const me = meResp.status === 'fulfilled' && meResp.value.ok ? await meResp.value.json() : {};
            const stats = statsResp.status === 'fulfilled' && statsResp.value.ok ? await statsResp.value.json() : {};
            const mems = memsResp.status === 'fulfilled' && memsResp.value.ok ? await memsResp.value.json() : [];
            const sess = sessResp.status === 'fulfilled' && sessResp.value.ok ? await sessResp.value.json() : {};
            const identity = me.identity || {};
            const session = sess.session || {};
            const name = me.full_name || (me.email || '').split('@')[0] || 'User';
            const lines = [`## About Me — ${name}\n`];
            if (identity.role) lines.push(`**Role:** ${identity.role}`);
            if (identity.primary_domain) lines.push(`**Domain:** ${identity.primary_domain}`);
            if (identity.expertise?.length) lines.push(`**Expertise:** ${identity.expertise.join(', ')}`);
            if (identity.tools?.length) lines.push(`**Tools I use:** ${identity.tools.join(', ')}`);
            if (identity.work_style) lines.push(`**Work style:** ${identity.work_style}`);
            if (session.context) lines.push(`**Working on:** ${session.context}`);
            const total = stats.total_memories || 0;
            const thisWeek = stats.memories_this_week || 0;
            const BLOCKLIST = new Set(['user', 'purmemo-web']);
            const platforms = (stats.platforms || []).filter(p => p && !BLOCKLIST.has(p.toLowerCase()) && !p.includes(' '));
            if (total) lines.push(`\n**Memory vault:** ${total.toLocaleString()} memories across ${platforms.slice(0, 6).join(', ')}`);
            if (thisWeek) lines.push(`**This week:** ${thisWeek} memories saved`);
            const memList = Array.isArray(mems) ? mems : (mems.memories || []);
            const projCounts = {};
            for (const m of memList) {
              const proj = (m.project_name || '').trim();
              if (proj) projCounts[proj] = (projCounts[proj] || 0) + 1;
            }
            const ranked = Object.entries(projCounts).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3);
            if (ranked.length) lines.push(`\n**Recent work:** ${ranked.map(([p, c]) => `${p} (${c} recent)`).join('; ')}`);
            text = lines.join('\n');
          } else if (uri === 'memory://context' || uri === 'memory://projects' || uri === 'memory://stats') {
            // Delegate to existing handlers via makeApiCall
            try {
              if (uri === 'memory://context') {
                const data = await fetch(`${API_URL}/api/v1/memories/?limit=5&sort=created_at&order=desc`, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
                const mems = data.ok ? await data.json() : [];
                const memList = Array.isArray(mems) ? mems : (mems.memories || []);
                text = memList.map((m, i) => `${i + 1}. **${m.title || 'Untitled'}** (${new Date(m.created_at).toLocaleDateString()})\n   ${(m.content || '').substring(0, 150)}...`).join('\n\n');
              } else if (uri === 'memory://projects') {
                const data = await fetch(`${API_URL}/api/v1/memories/?limit=20&sort=created_at&order=desc`, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
                const mems = data.ok ? await data.json() : [];
                const memList = Array.isArray(mems) ? mems : (mems.memories || []);
                const byProj = {};
                for (const m of memList) { const p = m.project_name || 'Other'; (byProj[p] = byProj[p] || []).push(m.title || 'Untitled'); }
                text = Object.entries(byProj).map(([p, titles]) => `## ${p}\n${titles.slice(0, 3).map(t => `- ${t}`).join('\n')}`).join('\n\n');
              } else {
                const data = await fetch(`${API_URL}/api/v1/stats/`, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
                const stats = data.ok ? await data.json() : {};
                text = `## Memory Vault Stats\n\n**Total:** ${stats.total_memories || 0}\n**This week:** ${stats.memories_this_week || 0}\n**Platforms:** ${(stats.platforms || []).join(', ')}`;
              }
            } catch (e) { text = `Error loading ${uri}: ${e.message}`; }
          } else if (uri.startsWith('memory://')) {
            const memId = uri.replace('memory://', '');
            try {
              const data = await fetch(`${API_URL}/api/v1/memories/${memId}/`, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
              text = data.ok ? JSON.stringify(await data.json(), null, 2) : `Memory not found: ${memId}`;
              mimeType = 'application/json';
            } catch (e) { text = `Error: ${e.message}`; }
          } else {
            return sendJSON(res, { jsonrpc: '2.0', id: requestId, error: { code: -32602, message: `Unknown resource: ${uri}` } });
          }

          return sendJSON(res, {
            jsonrpc: '2.0', id: requestId,
            result: { contents: [{ uri, mimeType, text }] }
          });
        } catch (e) {
          return sendJSON(res, { jsonrpc: '2.0', id: requestId, error: { code: -32603, message: e.message } });
        }
      }

      // ── prompts/list ──
      if (method === 'prompts/list') {
        return sendJSON(res, { jsonrpc: '2.0', id: requestId, result: { prompts: PROMPTS } });
      }

      // ── prompts/get ──
      if (method === 'prompts/get') {
        const promptName = body?.params?.name || '';
        const promptArgs = body?.params?.arguments || {};
        // Delegate to existing prompt handler logic
        let messages;
        if (promptName === 'load-context') {
          const topic = promptArgs.topic || '';
          messages = [{ role: 'user', content: { type: 'text', text: topic
            ? `Before I start working on "${topic}", please recall relevant past conversations using recall_memories.`
            : `Please load my recent context using recall_memories. Search for my most recent work and summarize.` } }];
        } else if (promptName === 'save-this-conversation') {
          messages = [{ role: 'user', content: { type: 'text', text: `Please save our current conversation using the save_conversation tool. Include the COMPLETE conversation content.` } }];
        } else if (promptName === 'catch-me-up') {
          const project = promptArgs.project || 'this project';
          messages = [{ role: 'user', content: { type: 'text', text: `Please catch me up on "${project}" using recall_memories. Summarize what's been done, what's in progress, and what's next.` } }];
        } else if (promptName === 'weekly-review') {
          messages = [{ role: 'user', content: { type: 'text', text: `Please give me a weekly review using recall_memories. Search conversations from the past 7 days and organize by projects, decisions, and next steps.` } }];
        } else {
          return sendJSON(res, { jsonrpc: '2.0', id: requestId, error: { code: -32602, message: `Unknown prompt: ${promptName}` } });
        }
        return sendJSON(res, { jsonrpc: '2.0', id: requestId, result: { description: `Prompt: ${promptName}`, messages } });
      }

      // ── tools/call — SSE streaming response ──
      if (method === 'tools/call') {
        const toolName = body?.params?.name;
        const toolArgs = body?.params?.arguments || {};
        if (!toolName) {
          return sendSSE(res, { jsonrpc: '2.0', id: requestId, error: { code: -32602, message: 'Missing tool name' } });
        }

        structuredLog.info('Tool call via /mcp/messages', { tool: toolName });

        const result = await executeToolForRemote(toolName, toolArgs, apiKey);

        if (result?.error) {
          return sendSSE(res, { jsonrpc: '2.0', id: requestId, error: { code: -32603, message: result.error } });
        }

        // Pre-formatted errors (quota, auth) already have content
        if (result?.isError && result?.content) {
          return sendSSE(res, { jsonrpc: '2.0', id: requestId, result });
        }

        // Normal result — wrap in content if needed
        const content = result?.content || [{ type: 'text', text: JSON.stringify(result?.data || result, null, 2) }];
        return sendSSE(res, { jsonrpc: '2.0', id: requestId, result: { content } });
      }

      // ── Unknown method ──
      return sendJSON(res, { jsonrpc: '2.0', id: requestId, error: { code: -32601, message: `Method not found: ${method}` } });

    } catch (error) {
      structuredLog.error('Error in /mcp/messages', { error: error.message });
      reportIncident(error.message, { component: 'mcp-messages-handler' });
      if (!res.headersSent) {
        sendJSON(res, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } }, 500);
      }
    }
  });

  // ── GET /mcp/messages — SSE keepalive stream ──
  app.get('/mcp/messages', async (req, res) => {
    if (!req.headers.accept?.includes('text/event-stream')) {
      return res.status(406).json({ error: 'Must accept text/event-stream' });
    }
    const apiKey = await validateApiKeyFromRequest(req);
    if (!apiKey) return res.status(401).json({ error: 'Authentication required' });

    const sessionId = req.headers['mcp-session-id'] || randomUUID();
    if (!mcpSessions.has(sessionId)) {
      mcpSessions.set(sessionId, { token: apiKey, createdAt: Date.now(), lastActivity: Date.now() });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': sessionId,
      ...CORS_HEADERS
    });

    const heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return; }
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/keepalive', params: { timestamp: new Date().toISOString() } })}\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      connMonitor.trackDisconnection(sessionId);
    });
  });

  // ── DELETE /mcp/messages — session termination ──
  app.delete('/mcp/messages', (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) return res.status(400).send('Missing Mcp-Session-Id');
    if (mcpSessions.delete(sessionId)) {
      connMonitor.trackDisconnection(sessionId);
      return res.status(204).end();
    }
    res.status(404).end();
  });

  // ── OPTIONS /mcp/messages — CORS preflight ──
  // (already defined above)

  // ── /mcp — direct handlers (NOT aliases — ChatGPT validates this URL) ──
  app.options('/mcp', (req, res) => { res.writeHead(204, CORS_HEADERS); res.end(); });
  app.post('/mcp', async (req, res) => {
    // Same handler as /mcp/messages — ChatGPT uses this URL
    req.url = '/mcp/messages';
    return app._router.handle(req, res, () => res.status(404).end());
  });

  // ── /figma — Figma Make endpoint (header auth only, no OAuth discovery) ──
  // Figma Make auto-discovers OAuth from /.well-known and opens a broken OAuth popup.
  // This endpoint has NO corresponding /.well-known entry, so Figma uses headers directly.
  // Usage in Figma Make: MCP server URL = https://mcp.purmemo.ai/figma
  //                      Additional headers: Authorization = Bearer YOUR_API_KEY
  app.options('/figma', (req, res) => { res.writeHead(204, getCorsHeaders(req)); res.end(); });
  app.post('/figma', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      // Return 401 WITHOUT WWW-Authenticate — no OAuth discovery hint
      return sendJSON(res, {
        jsonrpc: '2.0', id: req.body?.id ?? null,
        error: { code: -32001, message: 'Authentication required. Add Authorization header: Bearer YOUR_API_KEY' }
      }, 401, getCorsHeaders(req));
    }
    req.url = '/mcp/messages';
    return app._router.handle(req, res, () => res.status(404).end());
  });

  // ── /mcp/sse — legacy SSE endpoint (Python had this) ──
  app.get('/mcp/sse', async (req, res) => {
    // Forward to /sse handler
    req.url = '/sse';
    return app._router.handle(req, res, () => res.status(404).end());
  });

  // ── Deprecated SSE transport (/sse + /messages) ──
  app.get('/sse', async (req, res) => {
    structuredLog.info('SSE connection established (deprecated transport)');
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    connMonitor.trackConnection(transport.sessionId, { type: 'sse' });
    connectionCount++;
    res.on('close', () => {
      delete transports[transport.sessionId];
      connMonitor.trackDisconnection(transport.sessionId);
      structuredLog.info('SSE connection closed', { session_id: transport.sessionId });
    });
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (transport instanceof SSEServerTransport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No SSE transport found for this session' },
        id: null
      });
    }
  });

  // ── MCP well-known endpoints (for OAuth discovery) ──
  // Helper: detect Figma Make requests (they send Origin: https://www.figma.com)
  function isFigmaRequest(req) {
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const ua = req.headers['user-agent'] || '';
    return origin.includes('figma.com') || referer.includes('figma.com') || ua.includes('Figma');
  }

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    // Figma Make: return 404 so it doesn't discover OAuth and trigger the broken popup
    if (isFigmaRequest(req)) return res.status(404).json({ error: 'not_found' });
    const serverUrl = `https://${req.get('host')}`;
    res.json({
      resource: serverUrl,
      authorization_servers: [serverUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write']
    });
  });

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    // Figma Make: return 404 so it doesn't discover OAuth and trigger the broken popup
    if (isFigmaRequest(req)) return res.status(404).json({ error: 'not_found' });
    const serverUrl = `https://${req.get('host')}`;
    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/oauth/authorize`,
      token_endpoint: `${serverUrl}/oauth/token`,
      registration_endpoint: `${serverUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: ['read', 'write']
    });
  });

  app.get('/.well-known/mcp', (req, res) => {
    const serverUrl = `https://${req.get('host')}`;
    res.json({
      mcp_version: '2025-06-18',
      server_name: 'pūrmemo MCP Server',
      server_version: CLIENT_VERSION,
      transports: [
        { type: 'http', url: `${serverUrl}/mcp` },
        { type: 'sse', url: `${serverUrl}/sse` }
      ],
      authentication: {
        type: 'oauth2',
        authorization_endpoint: `${serverUrl}/oauth/authorize`,
        token_endpoint: `${serverUrl}/oauth/token`,
        scopes: ['read', 'write'],
        pkce_required: true
      },
      capabilities: { tools: true, resources: true, prompts: true }
    });
  });

  app.get('/.well-known/mcp.json', (req, res) => {
    req.url = '/.well-known/mcp';
    app.handle(req, res);
  });

  app.get('/.well-known/mcp-manifest.json', (req, res) => {
    const serverUrl = `https://${req.get('host')}`;
    res.json({
      name: 'purmemo',
      version: CLIENT_VERSION,
      description: 'AI-powered memory and knowledge management platform — save and recall conversations across Claude, ChatGPT, Gemini, and more',
      icon: `${serverUrl}/icon.png`,
      author: 'Purmemo',
      homepage: 'https://purmemo.ai',
      license: 'MIT',
      capabilities: { tools: true, resources: true, prompts: true },
      authentication: {
        type: 'oauth2',
        authorization_url: `${serverUrl}/oauth/authorize`,
        token_url: `${serverUrl}/oauth/token`,
        registration_url: `${serverUrl}/oauth/register`,
        scope: 'read write',
        pkce: true,
        pkce_method: 'S256'
      },
      endpoints: {
        base_url: serverUrl,
        mcp: '/mcp/messages',
        sse: '/sse',
        health: '/health'
      },
      tools: TOOLS.map(t => ({ name: t.name, description: t.description.split('\n')[0] })),
      contact: { email: 'support@purmemo.ai', documentation: 'https://docs.purmemo.ai/mcp' }
    });
  });

  // ── OAuth Module ──
  const { generateCode, storeAuthCode, exchangeCodeForToken } = await import('./oauth-simple.js');
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath: furl } = await import('node:url');
  const __remoteDir = dirname(furl(import.meta.url));

  // In-memory stores for OAuth state and refresh tokens
  // Both have TTL cleanup to prevent unbounded memory growth
  const oauthStateStorage: Record<string, { params: string; provider: string; createdAt: number }> = {};
  const refreshTokenStore: Record<string, { token: string; createdAt: number }> = {};

  // Clean up abandoned OAuth states (>10 min) and expired refresh tokens (>24 hr)
  setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(oauthStateStorage)) {
      if (now - oauthStateStorage[key].createdAt > 600_000) delete oauthStateStorage[key];
    }
    for (const key of Object.keys(refreshTokenStore)) {
      if (now - refreshTokenStore[key].createdAt > 86_400_000) delete refreshTokenStore[key];
    }
  }, 300_000); // every 5 minutes

  // Rate limiter (per-IP, leaky bucket)
  const rateLimits = {};
  function checkRateLimit(ip, endpoint, limit, windowSec = 60) {
    const key = `${ip}:${endpoint}`;
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const timestamps = (rateLimits[key] || []).filter(t => t > now - windowMs);
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    rateLimits[key] = timestamps;
    return true;
  }
  function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  }

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });

  // Parse URL-encoded form bodies (for login/register POST)
  const { urlencoded } = await import('express');
  app.use(urlencoded({ extended: true }));

  // ── OAuth: Dynamic Client Registration ──
  app.post('/oauth/register', (req, res) => {
    if (isFigmaRequest(req)) return res.status(404).json({ error: 'not_found' });
    if (!checkRateLimit(getClientIp(req), 'register', 5)) {
      return res.status(429).json({ error: 'Too many registration requests. Retry after 60 seconds.' });
    }
    const body = req.body || {};
    const clientId = `claude-${randomUUID().substring(0, 8)}`;
    res.json({
      client_id: clientId,
      client_name: body.client_name || 'Claude Desktop',
      redirect_uris: body.redirect_uris || [],
      grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
      response_types: body.response_types || ['code'],
      scope: body.scope || 'read write',
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0
    });
  });

  // ── OAuth: Authorization Endpoint ──
  app.get('/oauth/authorize', async (req, res) => {
    if (!checkRateLimit(getClientIp(req), 'authorize', 10)) {
      return res.status(429).json({ error: 'Too many authorization requests.' });
    }
    const { client_id, redirect_uri, code_challenge, code_challenge_method = 'S256',
            scope, state, session } = req.query;

    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });
    if (!redirect_uri) return res.status(400).json({ error: 'Missing redirect_uri' });
    if (!code_challenge) return res.status(400).json({ error: 'Missing code_challenge (PKCE required)' });

    // If we have a session (base64-encoded API key), complete the flow
    if (session) {
      try {
        const apiKey = Buffer.from(session, 'base64').toString('utf8');
        // Validate against backend
        const meResp = await fetch(`${API_URL}/api/v1/auth/me`, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(10000)
        });
        if (meResp.ok) {
          const code = generateCode();
          storeAuthCode({ code, apiKey, clientId: client_id, redirectUri: redirect_uri,
            codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method, scope, state });

          let callbackUrl = redirect_uri + (redirect_uri.includes('?') ? '&' : '?') + `code=${code}`;
          if (state) callbackUrl += `&state=${state}`;

          // Return success page
          let successHtml = readFileSync(join(__remoteDir, 'success.html'), 'utf8');
          successHtml = successHtml.replace('<!-- REDIRECT_URL -->', callbackUrl);
          return res.type('html').send(successHtml);
        }
      } catch (e) {
        structuredLog.error('OAuth authorize session error', { error: e.message });
      }
    }

    // No session — redirect to login
    const oauthParams = Buffer.from(JSON.stringify({
      client_id, redirect_uri, code_challenge, code_challenge_method, scope, state
    })).toString('base64url');
    res.redirect(`/login?params=${oauthParams}`);
  });

  // ── OAuth: Login Page ──
  app.get('/login', (req, res) => {
    const params = req.query.params || '';
    const signupComplete = req.query.signup_complete;
    let html = readFileSync(join(__remoteDir, 'login.html'), 'utf8');
    // Inject params into template
    html = html.replace(/<!-- PARAMS -->/g, params);
    if (signupComplete) {
      html = html.replace('<!-- SIGNUP_BANNER -->',
        '<div class="success-banner">Account created — sign in below to continue.</div>');
    } else {
      html = html.replace('<!-- SIGNUP_BANNER -->', '');
    }
    res.type('html').send(html);
  });

  // ── Helper: mint or reuse a long-lived API key for OAuth sessions ────────────
  // JWTs expire in 4 hours and refresh tokens are in-memory (wiped on Render restart).
  // API keys are stored in v1_mvp.api_keys (DB), survive restarts, and last 365 days.
  async function mintOAuthApiKey(jwtToken: string): Promise<string | null> {
    const keyName = `claude.ai (${new Date().toISOString().split('T')[0]})`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwtToken}`,
      'User-Agent': USER_AGENT,
    };

    // Check for existing active claude.ai key to avoid accumulation on reconnect
    try {
      const listResp = await fetch(`${API_URL}/api/v1/api-keys/`, { headers, signal: AbortSignal.timeout(8000) });
      if (listResp.ok) {
        const { api_keys } = await listResp.json();
        const existing = api_keys?.find((k: any) => k.name?.startsWith('claude.ai') && k.is_active);
        if (existing?.key_prefix) {
          // Can't return the full key (only prefix is stored) — mint a fresh one
          // but revoke the old one first to keep the account clean
          await fetch(`${API_URL}/api/v1/api-keys/${existing.id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
        }
      }
    } catch { /* non-fatal — proceed to mint */ }

    // Mint a new long-lived API key
    const mintResp = await fetch(`${API_URL}/api/v1/api-keys/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: keyName }),
      signal: AbortSignal.timeout(8000),
    });
    if (!mintResp.ok) return null;
    const { full_key } = await mintResp.json();
    return full_key || null;
  }

  // ── Shared: build OAuth redirect URL from params ──────────────────────────
  function buildAuthorizeRedirect(sessionParam: string, params?: string): string {
    if (!params) return `/oauth/authorize?session=${sessionParam}`;
    const oauthParams = JSON.parse(Buffer.from(params, 'base64url').toString());
    let url = `/oauth/authorize?client_id=${oauthParams.client_id}`;
    url += `&redirect_uri=${encodeURIComponent(oauthParams.redirect_uri)}`;
    url += `&response_type=code&code_challenge=${oauthParams.code_challenge}`;
    url += `&code_challenge_method=${oauthParams.code_challenge_method || 'S256'}`;
    if (oauthParams.scope) url += `&scope=${oauthParams.scope}`;
    if (oauthParams.state) url += `&state=${oauthParams.state}`;
    url += `&session=${sessionParam}`;
    return url;
  }

  // ── OAuth: Login Submit ──
  app.post('/login', async (req, res) => {
    if (!checkRateLimit(getClientIp(req), 'login', 10)) {
      return res.status(429).send('Too many login attempts. Please wait a moment.');
    }
    const { email, password, params } = req.body;
    try {
      const authResp = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10000)
      });
      if (!authResp.ok) {
        const errParam = authResp.status === 429 ? 'rate_limit' : 'invalid_credentials';
        const loginUrl = params ? `/login?params=${params}&error=${errParam}` : `/login?error=${errParam}`;
        return res.redirect(loginUrl);
      }
      const authData = await authResp.json();
      const jwt = authData.access_token;
      if (!jwt) return res.status(500).send('No token returned from login');

      // Mint a long-lived API key — survives Render restarts and 4hr JWT expiry
      const longLivedKey = await mintOAuthApiKey(jwt);
      if (!longLivedKey) return res.status(500).send('Failed to provision API key');

      const sessionParam = Buffer.from(longLivedKey).toString('base64');
      return res.redirect(buildAuthorizeRedirect(sessionParam, params));
    } catch (e) {
      structuredLog.error('Login error', { error: e.message });
      res.status(500).send('Login failed');
    }
  });

  // ── OAuth: Register Submit ──
  app.post('/register', async (req, res) => {
    if (!checkRateLimit(getClientIp(req), 'register', 10)) {
      return res.status(429).send('Too many registration attempts. Please wait a moment.');
    }
    const { email, password, params } = req.body;
    try {
      const regResp = await fetch(`${API_URL}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10000)
      });
      if (!regResp.ok) {
        const loginUrl = params ? `/login?params=${params}` : '/login';
        return res.redirect(loginUrl);
      }
      const authData = await regResp.json();
      const jwt = authData.access_token;
      if (!jwt) {
        const loginUrl = params ? `/login?params=${params}&signup_complete=1` : '/login?signup_complete=1';
        return res.redirect(loginUrl);
      }

      // Mint a long-lived API key — survives Render restarts and 4hr JWT expiry
      const longLivedKey = await mintOAuthApiKey(jwt);
      if (!longLivedKey) {
        const loginUrl = params ? `/login?params=${params}&signup_complete=1` : '/login?signup_complete=1';
        return res.redirect(loginUrl);
      }

      const sessionParam = Buffer.from(longLivedKey).toString('base64');
      return res.redirect(buildAuthorizeRedirect(sessionParam, params));
    } catch (e) {
      structuredLog.error('Register error', { error: e.message });
      res.status(500).send('Registration failed');
    }
  });

  // ── OAuth: Check Email (proxy to avoid CORS) ──
  app.post('/check-email', async (req, res) => {
    if (!checkRateLimit(getClientIp(req), 'check-email', 20)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    try {
      const { email } = req.body;
      const resp = await fetch(`${API_URL}/api/v1/auth/check-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) return res.json(await resp.json());
      res.json({ exists: false });
    } catch { res.json({ exists: false }); }
  });

  // ── OAuth: Google Login ──
  app.get('/oauth/google/login', (req, res) => {
    const params = req.query.params || '';
    const stateId = randomUUID();
    let statePayload = stateId;
    if (params) {
      oauthStateStorage[stateId] = { params, provider: 'google', createdAt: Date.now() };
      statePayload = Buffer.from(JSON.stringify({ id: stateId, params, provider: 'google' })).toString('base64url');
    }
    const callbackUrl = `https://${req.get('host')}/oauth/callback`;
    res.redirect(`${API_URL}/api/v1/oauth/google/login?return_url=${callbackUrl}&state=${statePayload}`);
  });

  // ── OAuth: GitHub Login ──
  app.get('/oauth/github/login', (req, res) => {
    const params = req.query.params || '';
    const stateId = randomUUID();
    let statePayload = stateId;
    if (params) {
      oauthStateStorage[stateId] = { params, provider: 'github', createdAt: Date.now() };
      statePayload = Buffer.from(JSON.stringify({ id: stateId, params, provider: 'github' })).toString('base64url');
    }
    const callbackUrl = `https://${req.get('host')}/oauth/callback`;
    res.redirect(`${API_URL}/api/v1/oauth/github/login?return_url=${callbackUrl}&state=${statePayload}`);
  });

  // ── OAuth: Callback (from social login) ──
  app.get('/oauth/callback', async (req, res) => {
    try {
      const { token, refresh_token: callbackRefreshToken, state, error } = req.query;
      if (error) return res.status(400).send(`OAuth failed: ${error}`);
      if (!token || !state) return res.status(400).send('Missing token or state');

      // Recover MCP params from state
      let mcpParams = null;
      if (oauthStateStorage[state]) {
        mcpParams = oauthStateStorage[state].params;
        delete oauthStateStorage[state];
      } else {
        try {
          const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
          mcpParams = decoded.params;
          if (decoded.id && oauthStateStorage[decoded.id]) delete oauthStateStorage[decoded.id];
        } catch {
          return res.status(400).send('Invalid or expired OAuth state');
        }
      }
      if (!mcpParams) return res.status(400).send('No MCP parameters found');

      // Decode MCP params
      const decodedParams = JSON.parse(Buffer.from(mcpParams, 'base64').toString());

      // Validate token against backend
      const meResp = await fetch(`${API_URL}/api/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!meResp.ok) return res.status(401).send('Invalid token');

      // Store refresh token in-memory AND persist so a Render restart can't
      // wipe the user's silent-refresh path (the whole point of mcp_refresh_tokens).
      if (callbackRefreshToken) {
        refreshTokenStore[token] = { token: callbackRefreshToken, createdAt: Date.now() };
        await saveRefreshToken(token, callbackRefreshToken);
      }

      // Generate MCP authorization code
      const authCode = generateCode();
      storeAuthCode({
        code: authCode, apiKey: token, clientId: decodedParams.client_id,
        redirectUri: decodedParams.redirect_uri, codeChallenge: decodedParams.code_challenge,
        codeChallengeMethod: decodedParams.code_challenge_method || 'S256',
        refreshToken: callbackRefreshToken
      });

      // Build redirect
      let finalRedirect = decodedParams.redirect_uri + (decodedParams.redirect_uri.includes('?') ? '&' : '?') + `code=${authCode}`;
      if (decodedParams.state) finalRedirect += `&state=${decodedParams.state}`;

      // Return success page
      let successHtml = readFileSync(join(__remoteDir, 'success.html'), 'utf8');
      successHtml = successHtml.replace('<!-- REDIRECT_URL -->', finalRedirect);
      res.type('html').send(successHtml);
    } catch (e) {
      structuredLog.error('OAuth callback error', { error: e.message });
      res.status(500).send('OAuth callback failed');
    }
  });

  // ── OAuth: Token Exchange ──
  // async: the handler awaits saveRefreshToken. This file is @ts-nocheck, so
  // the missing `async` was invisible to tsc and shipped as a runtime
  // SyntaxError that crash-looped the box service (2026-06-13). Verification
  // for this file = `node --check dist/remote/start.js` after build, not tsc.
  app.post('/oauth/token', async (req, res) => {
    if (!checkRateLimit(getClientIp(req), 'token', 20)) {
      return res.status(429).json({ error: 'Too many token requests.' });
    }
    const { grant_type, code, redirect_uri, code_verifier, client_id } = req.body;

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({ error: `Unsupported grant type: ${grant_type}` });
    }
    if (!code || !redirect_uri || !code_verifier) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const result = exchangeCodeForToken({ code, clientId: client_id, redirectUri: redirect_uri, codeVerifier: code_verifier });
    if (!result) {
      return res.status(400).json({ error: 'Invalid authorization code or PKCE verification failed' });
    }

    const [apiKey, storedRefreshToken] = result;
    if (storedRefreshToken) {
      refreshTokenStore[apiKey] = { token: storedRefreshToken, createdAt: Date.now() };
      await saveRefreshToken(apiKey, storedRefreshToken);
    }

    res.json({
      access_token: apiKey,
      token_type: 'Bearer',
      expires_in: 86400,
      scope: 'read write'
    });
  });

  // ── Favicon / Icon ──
  app.get('/favicon.ico', async (req, res) => {
    try {
      const { readFileSync: rfs } = await import('node:fs');
      const { dirname: dn, join: jn } = await import('node:path');
      const { fileURLToPath: fu } = await import('node:url');
      const iconPath = jn(dn(fu(import.meta.url)), 'icon.png');
      const data = rfs(iconPath);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(data);
    } catch { res.status(404).end(); }
  });

  app.get('/icon.png', async (req, res) => {
    req.url = '/favicon.ico';
    return app._router.handle(req, res, () => res.status(404).end());
  });

  // ── Root endpoint ──
  app.get('/', (req, res) => {
    const serverUrl = `https://${req.get('host')}`;
    res.json({
      name: 'pūrmemo MCP Server',
      version: CLIENT_VERSION,
      status: 'running',
      endpoints: {
        mcp: `${serverUrl}/mcp`,
        sse: `${serverUrl}/sse`,
        health: `${serverUrl}/health`,
        oauth_discovery: `${serverUrl}/.well-known/oauth-authorization-server`
      }
    });
  });

  // Start
  const PORT = parseInt(process.env.PORT || '8000', 10);

  resolveApiKey().then(apiKey => {
    resolvedApiKey = apiKey;
    setResolvedApiKey(apiKey);
    checkForUpdates();

    app.listen(PORT, () => {
      structuredLog.info('Purmemo Remote MCP Server started', {
        mode: 'remote',
        version: CLIENT_VERSION,
        port: PORT,
        api_url: API_URL,
        api_key_configured: !!resolvedApiKey,
        tools_count: TOOLS.length,
        transports: ['streamable-http', 'sse'],
        endpoints: {
          mcp: '/mcp (Streamable HTTP — POST/GET/DELETE)',
          sse: '/sse (deprecated SSE — GET)',
          messages: '/messages (deprecated SSE — POST)',
          health: '/health'
        }
      });
    });
  }).catch(error => {
    structuredLog.error('Failed to start remote MCP server', { error_message: error.message });
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    structuredLog.info('Shutting down remote server...');
    clearInterval(sessionCleanupInterval);
    connMonitor.stop();
    for (const sid in transports) {
      try { await transports[sid].close(); } catch {}
      delete transports[sid];
    }
    process.exit(0);
  });
} // end startRemoteServer
