/**
 * Incident reporter — the desktop app's spoke into the purmemo incident hub
 * (Unified Observability PRD, Phase 1).
 *
 * Mirrors the shipped Chrome extension reporter: crashes report a NORMALIZED
 * error signature to the hub's AUTHED ingest using the user's own stored
 * credential (from the OS keychain via ./keychain) — no shared secrets.
 *
 * PRIVACY (PRD, strict): signature + component + route only. Never raw stacks,
 * never user content, never the token in a log.
 *
 * STORM GUARD: in-memory dedup + hard cap per app session.
 * Fire-and-forget: never throws, never awaited by callers.
 */

import { getAccessToken } from './keychain';

const API_BASE = 'https://api.purmemo.ai';

const reported = new Set<string>();
let reportsThisSession = 0;
const MAX_REPORTS_PER_SESSION = 20;

/** Strip volatile parts so the hub dedups by error class. */
export function normalizeSignature(raw: unknown): string {
  return String(raw)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/https?:\/\/[^\s"')]+/g, '<url>')
    .slice(0, 400);
}

/**
 * Report an incident. Fire-and-forget; safe to call from anywhere in main or
 * (via IPC) the renderer. Never throws.
 */
export function reportIncident(
  raw: unknown,
  ctx: { component?: string; route?: string } = {},
): void {
  try {
    const signature = normalizeSignature(raw);
    if (signature.length < 3) return;
    if (reported.has(signature)) return;
    if (reportsThisSession >= MAX_REPORTS_PER_SESSION) return;
    reported.add(signature);
    reportsThisSession += 1;

    getAccessToken().then((token) => {
      if (!token) return; // signed-out: nothing to report with, degrade silently
      fetch(`${API_BASE}/api/v1/incidents/report-authed`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          source: 'desktop',
          signature,
          component: ctx.component ?? 'general',
          route: ctx.route,
        }),
      }).catch(() => {});
    }).catch(() => {});
  } catch {
    // observability must never break the app
  }
}
