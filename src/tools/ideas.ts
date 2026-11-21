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
import { makeSessionsCall, sanitizeUnicode, safeErrorMessage, getEffectiveApiKey } from '../lib/api-client.js';
import { currentAccountScope, defaultAccount, isRemoteMode } from '../auth/accounts.js';
import { writePending, readPending, removePending, refusePending, pendingSummary, signInFingerprint, accountFolder, halfWrittenWaiting, PENDING_RESEND_MAX, TMP_ORPHAN_MS } from '../lib/pending-ideas.js';

export const IDEA_SURFACES = ['terminal_session', 'bauhaus_conversation', 'cosmo', 'app_voice_note', 'share_sheet', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v, max) => { const s = typeof v === 'string' ? sanitizeUnicode(v).trim() : ''; return s ? s.slice(0, max) : null; };
// The account whose sign-in this process loaded. The name of the active account on this machine can be switched
// under a running connector, and the sign-in in use does not follow. Recorded by the very step that loads the
// sign-in (server.ts resolveApiKey → signInLoadedFor), so the two can never describe different moments. Until
// that has happened no account is known, and a call that names "the default account" is refused.
let STARTED_AS: string | null = null; let SIGN_IN_LOADED = false;
export function signInLoadedFor(account: string | null) { STARTED_AS = account ? String(account).toLowerCase() : null; SIGN_IN_LOADED = true; }
export const startedAs = () => ({ account: STARTED_AS, loaded: SIGN_IN_LOADED });

/**
 * The account a capture is made for, which must be the account whose sign-in sends it. → { account } or
 * { mismatch: true } when the call names "the default account" but that name has changed since this connector
 * started: the sign-in in use is still the earlier account's, so the idea would go to the wrong one.
 */
export function accountForCapture(scope, startedAs: string | null) {
  const started = (startedAs || '').toLowerCase();
  if (scope && !scope.isDefault) return { account: String(scope.email).toLowerCase() };
  if (scope && scope.isDefault && String(scope.email).toLowerCase() !== started) return { mismatch: true };
  return { account: started || 'default' };
}
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** The error code purmemo-next sent, from the tagged error's message ("API Error 409: {...}"). */
function refusalOf(err) {
  const m = /API Error \d+: (.*)$/s.exec(String(err?.message || ''));
  try { const j = JSON.parse(m ? m[1] : ''); return { code: j.error || null, message: j.message || null }; } catch { return { code: null, message: null }; }
}
// purmemo's own "no" to this capture. Everything else (no network, timeout, 5xx, sign-in, plan not confirmed,
// rate limit) is "could not ask" and the capture stays pending. A 404 is a "no" only when purmemo names the
// thing it does not hold; a bare 404 is a server that does not have these routes yet, which is "could not ask".
const isRefusal = (err) => [400, 409, 413, 422].includes(err?.status) || (err?.status === 404 && refusalOf(err).code === 'unavailable');

/**
 * Send one capture: find its project, then note the idea. → { state: 'saved' | 'pending' | 'refused', … }.
 * Never throws.
 */
export async function sendCapture(capture, call = makeSessionsCall) {
  try {
    const body = { ...capture.body, client_id: capture.client_id, id: capture.id };
    // A session of another account is never named to this one, whatever the file on the device holds.
    if (body.said_in && body.said_in.account) body.said_in = { surface: body.said_in.surface, account: 'another-account' };
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
    // Saved means purmemo SAID saved, and gave the idea back. Any other answer, however polite, is not that.
    if (!(saved && saved.ok === true && saved.saved === true && saved.idea && saved.idea.id)) return { state: 'pending', why: 'purmemo answered without confirming the idea was saved', status: null };
    return { state: 'saved', filed, idea: saved.idea, duplicate: !!saved.duplicate };
  } catch (err) {
    if (isRefusal(err)) { const r = refusalOf(err); return { state: 'refused', reason: r.message || r.code || safeErrorMessage(err), code: r.code }; }
    return { state: 'pending', why: err?.status === 403 ? 'ideas are not switched on for this account yet' : String(safeErrorMessage(err)).split('\n')[0], status: err?.status ?? null };
  }
}

/**
 * Send what is waiting for an account, oldest first, with the sign-in whose fingerprint is `fingerprint`. A capture
 * made under a different sign-in is left exactly where it is: it is only ever sent with its own.
 * → { sent, refused, still, other_sign_in }. Never throws.
 */
export async function resendPending(account, call = makeSessionsCall, env = process.env, except = null, fingerprint = undefined) {
  const out = { sent: 0, refused: 0, still: 0, other_sign_in: 0 };
  try {
    const fp = fingerprint === undefined ? signInFingerprint(getEffectiveApiKey()) : fingerprint;
    let tried = 0;
    for (const capture of readPending(account, env).captures) {
      if (capture.client_id === except) continue;
      // Only with the sign-in it was made under, and only for the account whose folder it is in. A capture that
      // does not say (none was ever written that way by a released connector) is left where it is.
      if (!fp || capture.sign_in !== fp || accountFolder(capture.account) !== accountFolder(account)) { out.other_sign_in += 1; continue; }
      if (tried >= PENDING_RESEND_MAX) break;
      tried += 1;
      const r = await sendCapture(capture, call);
      if (r.state === 'saved') { removePending(account, capture.client_id, env); out.sent += 1; }
      else if (r.state === 'refused') { refusePending(account, capture, r.reason, env); out.refused += 1; }
      else { writePending(account, { ...capture, attempts: (capture.attempts || 0) + 1, last_error: r.why, last_tried_at: new Date().toISOString() }, env); out.still += 1; break; } // could not ask: stop, try again later
    }
  } catch (err) {
    structuredLog.warn('note_idea: sending waiting ideas stopped', { error: safeErrorMessage(err) });
  }
  return out;
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
    // The account this call runs on: the one named by `account`, else this machine's default sign-in.
    const scope = deps.scope !== undefined ? deps.scope : currentAccountScope();
    const forWhom = deps.account ? { account: deps.account() } : accountForCapture(scope, deps.startedAs !== undefined ? deps.startedAs : STARTED_AS);
    if (!deps.account && deps.startedAs === undefined && !SIGN_IN_LOADED && !isRemoteMode(env) && scope?.isDefault) forWhom.mismatch = true;
    if (forWhom.mismatch) return text('❌ The idea is NOT saved. This connector started signed in as a different account than the one named, and the default account on this machine has been switched since. Restart the connector, then say it again.', true);
    const account = forWhom.account;
    // Noted into ANOTHER signed-in account (a bauhaus idea said at home goes to the work account): this session
    // is kept under this machine's default account, not the one the idea goes to. purmemo is told so, and then
    // keeps only the kind of surface and the date there: never the machine or the session.
    const elsewhere = deps.sessionElsewhere !== undefined ? deps.sessionElsewhere : !!(scope && !scope.isDefault);
    // Exact words need the session they are in, and a session of another account is not sent anywhere: there the
    // words are a note of what was said.
    const exact = args?.exact_words === true && !!words && !!session && !elsewhere;
    const fingerprint = deps.fingerprint !== undefined ? deps.fingerprint : signInFingerprint(getEffectiveApiKey());
    const remote = isRemoteMode(env);
    const capture = {
      client_id: `idea-${randomUUID()}`, id: randomUUID(), account, sign_in: fingerprint, created_at: now().toISOString(), attempts: 0,
      project_id: projectId ? projectId.toLowerCase() : null, repository: str(args?.repository, 500),
      body: {
        title, note: str(args?.note, 4000), words, words_are: exact ? 'his_exact' : 'noted', said_at: now().toISOString(),
        // Into another account: the surface, and the plain fact that the session lives elsewhere. Not the machine,
        // not the session id, not the name of the account it lives in: none of those leave this account's requests.
        said_in: elsewhere ? { surface, account: 'another-account' } : { surface, ...(remote ? {} : { machine: hostname() }), ...(session ? { session } : {}) },
      },
    };
    // The hosted connector has no device to keep a file on: there the idea is saved or it is not, and it says which.
    // On a device the capture is written first, ALWAYS: sent without that, an answer lost on the way back would
    // leave nothing to send again under the same id, and saying it again would make a second idea.
    if (!remote) {
      try { writePending(account, capture, env); } catch (err) {
        structuredLog.warn('note_idea: could not write the pending file', { error: safeErrorMessage(err) });
        return text('❌ The idea is NOT saved: it could not be written to this device first, so it was not sent. Check the purmemo pending folder on this device can be written, then say it again.', true);
      }
    }
    const r = await sendCapture(capture, call);
    const noteExact = args?.exact_words === true && !exact ? ` Kept as a note of what was said, not as exact words: ${elsewhere ? 'this session belongs to another account than the idea, so it is not named there' : 'exact words need the words and the session_id they are in'}.` : '';
    if (r.state === 'saved') {
      if (!remote) { try { removePending(account, capture.client_id, env); } catch { /* a later pass finds it and purmemo answers "already saved" */ } }
      // The idea IS saved from here on: nothing that follows may turn this reply into a failure.
      let flushed = { sent: 0, refused: 0, other_sign_in: 0 }; let waitingNote = '';
      if (!remote) {
        flushed = await resendPending(account, call, env, capture.client_id, fingerprint);
        try {
          const left = pendingSummary(account, env, now().getTime(), fingerprint);
          if (left.unreadable) waitingNote += ` ${left.unreadable} file(s) in this device's pending folder could not be read; they are kept there and need a look.`;
          if (left.other_sign_in) waitingNote += ` ${left.other_sign_in} idea(s) on this device were captured under a different sign-in and wait for it; they are not sent with this one.`;
        } catch { /* the reply stands */ }
      }
      const where = r.filed === 'unfiled' ? 'not filed under a project (none was named)'
        : r.filed === 'not_known' ? 'not filed under a project: purmemo does not know this repository in this account yet. It is in your unfiled ideas.'
          : r.filed === 'meant_for' ? 'kept in this account, unfiled, marked as meant for a project this account cannot reach'
            : `in project ${r.filed}`;
      structuredLog.info('note_idea: saved', { filed: r.filed, flushed: flushed.sent });
      return text(`✅ Idea saved to purmemo: "${title}"${r.idea?.name ? ` (${r.idea.name})` : ''}, ${where}.${noteExact}${flushed.sent ? ` Also sent ${flushed.sent} idea(s) that had been waiting on this device.` : ''}${flushed.refused ? ` ${flushed.refused} waiting idea(s) were refused and are kept on this device under refused/.` : ''}${waitingNote}`);
    }
    if (r.state === 'refused') {
      let kept = remote ? '' : ' It is kept on this device (refused) so the words are not lost.';
      // If it cannot be set aside it is still where it was written first: on the device, waiting.
      if (!remote) { try { refusePending(account, capture, r.reason, env); } catch { kept = ' It is still on this device, among the waiting ideas, so the words are not lost.'; } }
      structuredLog.warn('note_idea: refused', { code: r.code });
      return text(`❌ purmemo did not take this idea: ${r.reason}. It is NOT saved.${kept}`, true);
    }
    structuredLog.warn('note_idea: pending', { status: r.status });
    if (remote) return text(`⚠️ The idea is NOT saved: purmemo did not answer (${r.why}). Say it again in a minute.`, true);
    const s = pendingSummary(account, env, now().getTime(), fingerprint);
    return text(`⏳ NOT saved yet: purmemo did not answer (${r.why}). The idea is waiting on this device as pending and will be sent again the next time an idea is noted and when the connector starts. Waiting on this device: ${s.count}${s.oldest_hours >= 24 ? `, the oldest for ${Math.round(s.oldest_hours)} hours` : ''}.${s.unreadable ? ` ${s.unreadable} file(s) in this device's pending folder could not be read; they are kept there and need a look.` : ''}${noteExact}`);
  };
}

export const handleNoteIdea = createNoteIdea();

/**
 * When the local connector starts: send what is waiting for this machine's default account, a few seconds in.
 * Nothing waiting = no network call at all. Ideas waiting for another signed-in account go the next time a call
 * runs on that account (only that call holds that account's sign-in).
 */
export function sendWaitingIdeasAtStart(delayMs = 5000, env = process.env, call = makeSessionsCall, deps: any = {}) {
  if (env.PURMEMO_IDEAS_OFF === '1' || isRemoteMode(env)) return null;
  const account = deps.account ? deps.account() : (STARTED_AS || 'default');
  // The sign-in this process started with. Captures made under any other are left alone.
  const fingerprint = deps.fingerprint !== undefined ? deps.fingerprint : signInFingerprint(getEffectiveApiKey());
  let waiting; try { waiting = readPending(account, env); } catch { return null; }
  if (waiting.unreadable.length) structuredLog.warn('note_idea: files in the pending folder could not be read', { count: waiting.unreadable.length });
  if (!fingerprint) return null;
  // A capture whose write a crash cut short is put back once it is a minute old. If that is all there is, look
  // again then: otherwise it would wait for the next idea or the next start.
  const halfWritten = !waiting.captures.length && halfWrittenWaiting(account, env);
  if (!waiting.captures.length && !halfWritten) return null;
  if (halfWritten) delayMs = Math.max(delayMs, (deps.orphanMs !== undefined ? deps.orphanMs : TMP_ORPHAN_MS) + 1000);
  const t = setTimeout(() => {
    resendPending(account, call, env, null, fingerprint)
      .then((r) => structuredLog.info('note_idea: sent waiting ideas at start', r))
      .catch((err) => structuredLog.warn('note_idea: could not send waiting ideas at start', { error: safeErrorMessage(err) }));
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
  return t;
}
