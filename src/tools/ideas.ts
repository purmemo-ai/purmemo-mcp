// @ts-nocheck — typing deferred (matches handlers.ts convention)
/**
 * note_idea — note an idea the user said, into purmemo's idea records on purmemo-next (2026-11-21).
 *
 * One call, from any conversation. The capture is written to the pending file on this device FIRST
 * (lib/pending-ideas.ts), then sent. The reply says exactly one of three things, never more than is true:
 *   saved     purmemo answered; the idea is in the project (or unfiled)
 *   pending   purmemo could not be asked; the idea waits on this device and is sent again
 *   refused   purmemo said no; the idea is kept on this device with the reason
 * The idea's project is found from the id on the project's card or the folder's repository address. It is never
 * guessed from a name and a project is never created here.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { structuredLog } from '../lib/logger.js';
import { makeSessionsCall, sanitizeUnicode, safeErrorMessage } from '../lib/api-client.js';
import { currentAccountScope, defaultAccount, isRemoteMode } from '../auth/accounts.js';
import { writePending, listPending, removePending, refusePending, pendingSummary, PENDING_RESEND_MAX } from '../lib/pending-ideas.js';

export const IDEA_SURFACES = ['terminal_session', 'bauhaus_conversation', 'cosmo', 'app_voice_note', 'share_sheet', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v, max) => { const s = typeof v === 'string' ? sanitizeUnicode(v).trim() : ''; return s ? s.slice(0, max) : null; };
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** The error code purmemo-next sent, from the tagged error's message ("API Error 409: {...}"). */
function refusalOf(err) {
  const m = /API Error \d+: (.*)$/s.exec(String(err?.message || ''));
  try { const j = JSON.parse(m ? m[1] : ''); return { code: j.error || null, message: j.message || null }; } catch { return { code: null, message: null }; }
}
// purmemo's own "no" to this capture. Everything else (no network, timeout, 5xx, sign-in, plan not confirmed,
// rate limit) is "could not ask" and the capture stays pending.
const isRefusal = (err) => [400, 404, 409, 413, 422].includes(err?.status);

/**
 * Send one capture: find its project, then note the idea. → { state: 'saved' | 'pending' | 'refused', … }.
 * Never throws.
 */
export async function sendCapture(capture, call = makeSessionsCall) {
  try {
    const body = { ...capture.body, client_id: capture.client_id, id: capture.id };
    let filed = 'unfiled';
    if (capture.project_id || capture.repository) {
      const qs = new URLSearchParams();
      if (capture.project_id) qs.set('id', capture.project_id);
      if (capture.repository) qs.set('repository', capture.repository);
      const r = await call(`/api/v1/projects/resolve?${qs}`, { method: 'GET' });
      const byRepo = r?.repository?.answer === 'found' && r.repository.project ? r.repository.project : null;
      if (r?.answer === 'found' && r.project) { body.project_id = r.project.id; filed = r.project.name; }
      else if (r?.answer === 'unavailable' && byRepo) { body.project_id = byRepo.id; filed = byRepo.name; }
      else if (r?.answer === 'unavailable' && capture.project_id) { body.meant_for = capture.project_id; filed = 'meant_for'; }
      else filed = 'not_known';
    }
    const saved = await call('/api/v1/ideas', { method: 'POST', body: JSON.stringify(body) });
    return { state: 'saved', filed, idea: saved?.idea || null, duplicate: !!saved?.duplicate };
  } catch (err) {
    if (isRefusal(err)) { const r = refusalOf(err); return { state: 'refused', reason: r.message || r.code || safeErrorMessage(err), code: r.code }; }
    return { state: 'pending', why: err?.status === 403 ? 'ideas are not switched on for this account yet' : String(safeErrorMessage(err)).split('\n')[0], status: err?.status ?? null };
  }
}

/** Send what is waiting for an account, oldest first. → { sent, refused, still }. Never throws. */
export async function resendPending(account, call = makeSessionsCall, env = process.env, except = null) {
  let sent = 0; let refused = 0; let still = 0;
  for (const capture of listPending(account, env).slice(0, PENDING_RESEND_MAX)) {
    if (capture.client_id === except) continue;
    const r = await sendCapture(capture, call);
    if (r.state === 'saved') { removePending(account, capture.client_id, env); sent += 1; }
    else if (r.state === 'refused') { refusePending(account, capture, r.reason, env); refused += 1; }
    else { writePending(account, { ...capture, attempts: (capture.attempts || 0) + 1, last_error: r.why, last_tried_at: new Date().toISOString() }, env); still += 1; break; } // could not ask: stop, try again later
  }
  return { sent, refused, still };
}

/** Factory so tests can inject the transport and the environment. */
export function createNoteIdea(call = makeSessionsCall, deps: any = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  return async function handleNoteIdea(args: any) {
    const title = str(args?.idea, 300) || str(args?.title, 300);
    if (!title) return text('❌ note_idea needs the idea in a few words, e.g. note_idea({ idea: "Cut the video by voice" })', true);
    const surface = args?.said_in == null ? 'terminal_session' : String(args.said_in);
    if (!IDEA_SURFACES.includes(surface)) return text(`❌ said_in must be one of: ${IDEA_SURFACES.join(', ')}`, true);
    const projectId = str(args?.project_id, 100);
    if (projectId && !UUID.test(projectId)) return text('❌ project_id must be the id on the project\'s card (a UUID). Leave it out and pass repository instead, or neither.', true);
    const words = str(args?.words, 20000);
    const session = str(args?.session_id, 300);
    // "His exact words" is a claim: it needs the words and the session they are in. Otherwise it is a note of what he said.
    const exact = args?.exact_words === true && !!words && !!session;
    // The account this call runs on: the one named by `account`, else this machine's default sign-in.
    const account = deps.account ? deps.account() : (currentAccountScope()?.email || defaultAccount(env) || 'default');
    const remote = isRemoteMode(env);
    const capture = {
      client_id: `idea-${randomUUID()}`, id: randomUUID(), account, created_at: now().toISOString(), attempts: 0,
      project_id: projectId ? projectId.toLowerCase() : null, repository: str(args?.repository, 500),
      body: {
        title, note: str(args?.note, 4000), words, words_are: exact ? 'his_exact' : 'noted', said_at: now().toISOString(),
        said_in: { surface, ...(remote ? {} : { machine: hostname() }), ...(session ? { session } : {}) },
      },
    };
    // The hosted connector has no device to keep a file on: there the idea is saved or it is not, and it says which.
    if (!remote) writePending(account, capture, env);
    const r = await sendCapture(capture, call);
    const noteExact = args?.exact_words === true && !exact ? ' Kept as a note of what was said, not as exact words: exact words need the words and the session_id they are in.' : '';
    if (r.state === 'saved') {
      if (!remote) removePending(account, capture.client_id, env);
      const flushed = remote ? { sent: 0, refused: 0 } : await resendPending(account, call, env, capture.client_id);
      const where = r.filed === 'unfiled' ? 'not filed under a project (none was named)'
        : r.filed === 'not_known' ? 'not filed under a project: purmemo does not know this repository in this account yet. It is in your unfiled ideas.'
          : r.filed === 'meant_for' ? 'kept in this account, unfiled, marked as meant for a project this account cannot reach'
            : `in project ${r.filed}`;
      structuredLog.info('note_idea: saved', { filed: r.filed, flushed: flushed.sent });
      return text(`✅ Idea saved to purmemo: "${title}"${r.idea?.name ? ` (${r.idea.name})` : ''}, ${where}.${noteExact}${flushed.sent ? ` Also sent ${flushed.sent} idea(s) that had been waiting on this device.` : ''}${flushed.refused ? ` ${flushed.refused} waiting idea(s) were refused and are kept on this device under refused/.` : ''}`);
    }
    if (r.state === 'refused') {
      if (!remote) refusePending(account, capture, r.reason, env);
      structuredLog.warn('note_idea: refused', { code: r.code });
      return text(`❌ purmemo did not take this idea: ${r.reason}. It is NOT saved.${remote ? '' : ' It is kept on this device (refused) so the words are not lost.'}`, true);
    }
    structuredLog.warn('note_idea: pending', { status: r.status });
    if (remote) return text(`⚠️ The idea is NOT saved: purmemo did not answer (${r.why}). Say it again in a minute.`, true);
    const s = pendingSummary(account, env, now().getTime());
    return text(`⏳ NOT saved yet: purmemo did not answer (${r.why}). The idea is waiting on this device as pending and will be sent again the next time an idea is noted and when the connector starts. Waiting on this device: ${s.count}${s.oldest_hours >= 24 ? `, the oldest for ${Math.round(s.oldest_hours)} hours` : ''}.${noteExact}`);
  };
}

export const handleNoteIdea = createNoteIdea();

/**
 * When the local connector starts: send what is waiting for this machine's default account, a few seconds in.
 * Nothing waiting = no network call at all. Ideas waiting for another signed-in account go the next time a call
 * runs on that account (only that call holds that account's sign-in).
 */
export function sendWaitingIdeasAtStart(delayMs = 5000, env = process.env, call = makeSessionsCall) {
  if (env.PURMEMO_IDEAS_OFF === '1' || isRemoteMode(env)) return null;
  const account = defaultAccount(env) || 'default';
  if (!listPending(account, env).length) return null;
  const t = setTimeout(() => {
    resendPending(account, call, env)
      .then((r) => structuredLog.info('note_idea: sent waiting ideas at start', r))
      .catch((err) => structuredLog.warn('note_idea: could not send waiting ideas at start', { error: safeErrorMessage(err) }));
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
  return t;
}
