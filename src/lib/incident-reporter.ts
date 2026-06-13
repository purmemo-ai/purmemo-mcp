/**
 * Incident reporter — "the pipe" client for the remote MCP server.
 * Phase 1 of the Unified Observability PRD.
 *
 * Replaces the restart-volatile in-memory recentErrors array as the system of
 * record: errors now ALSO land in the purmemo error_incidents hub (source=mcp)
 * where /investigate-errors and the triage brain can see them. This is the gap
 * that hid the get_artifacts 422 bug.
 *
 * Fire-and-forget: never throws, never awaited by callers, 2s timeout so a
 * hub outage can never slow a tool call. Token via INCIDENT_REPORT_TOKEN
 * (shared secret with the API); unset → silent no-op (graceful degrade).
 *
 * PRIVACY: sends a normalized signature + tool name only. Never argument
 * payloads, never user content, never raw stacks.
 */

// Strip any trailing slash: PURMEMO_API_URL is set with a trailing "/" in the
// box env, which produced a double-slash URL (api.purmemo.ai//api/v1/...) that
// the API 404s — silently dropping every MCP incident report (found 2026-06-13).
const API_BASE = (process.env.PURMEMO_API_URL || 'https://api.purmemo.ai').replace(/\/+$/, '');

let warnedMissing = false;

/**
 * Normalize a raw error string into a stable signature: strip volatile parts
 * (UUIDs, long numbers, quoted values) so the hub dedups by error CLASS.
 */
export function normalizeSignature(raw: unknown): string {
  return String(raw)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .slice(0, 400);
}

/** Report an incident to the hub. Fire-and-forget. */
export function reportIncident(
  signature: string,
  ctx: { tool?: string; component?: string; status?: number } = {},
): void {
  const token = process.env.INCIDENT_REPORT_TOKEN;
  if (!token) {
    if (!warnedMissing) {
      console.error('[incident-reporter] INCIDENT_REPORT_TOKEN unset — hub reporting disabled (no-op).');
      warnedMissing = true;
    }
    return;
  }

  // Skip pure client-side noise: auth and quota outcomes are user-state, not
  // system failures. 422s ARE reported — contract violations hid real bugs.
  if (ctx.status === 401 || ctx.status === 403 || ctx.status === 429) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  fetch(`${API_BASE}/api/v1/incidents/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-incident-token': token },
    body: JSON.stringify({
      source: 'mcp',
      signature: normalizeSignature(signature),
      component: ctx.component || 'tool-execution',
      tool: ctx.tool,
    }),
    signal: controller.signal,
  })
    .catch(() => { /* never let observability break the server */ })
    .finally(() => clearTimeout(timer));
}
