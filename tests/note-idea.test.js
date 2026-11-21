/**
 * note_idea (2026-11-21): one call notes an idea in purmemo-next's idea records. The capture is written to the
 * pending file on the device first; the reply says saved, pending or refused and never more than is true; a
 * capture sent twice carries the same id so it can never become two ideas.
 * Exercised against the built dist and a real local stub HTTP server that can be switched off.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionsCall } from '../dist/lib/api-client.js';
import { createNoteIdea, resendPending, sendWaitingIdeasAtStart, accountForCapture, signInLoadedFor, startedAs, IDEA_SURFACES } from '../dist/tools/ideas.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listPending, readPending, writePending, pendingSummary, accountFolder, signInFingerprint } from '../dist/lib/pending-ideas.js';
import { GATED_TOOLS, gatedToolResult, isToolVisible, CAPTURE_TOOLS } from '../dist/lib/tool-visibility.js';
import { ACCOUNT_TOOLS } from '../dist/tools/accounts.js';

const PROJECT = '619e515d-474a-4c2f-8b32-cf87961f9f42';
let stub; let port; let dir; let env; let seen; let ideas; let mode;

function start() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
        if (mode === 'down') return send(503, { ok: false, error: 'internal_error' });
        if (mode === 'no-plan') return send(403, { ok: false, error: 'not_on_plan', feature: 'projects' });
        if (mode === 'no-routes') return send(404, { ok: false, error: 'not_found' });
        if (req.url.startsWith('/api/v1/projects/resolve')) {
          const u = new URL(req.url, 'http://x');
          if (u.searchParams.get('id') === PROJECT || u.searchParams.get('repository') === 'git@github.com:coladapo/bauhaus.git') return send(200, { ok: true, answer: 'found', project: { id: PROJECT, name: 'bauhaus' } });
          return send(200, { ok: true, answer: u.searchParams.get('id') ? 'unavailable' : 'not_known' });
        }
        if (req.method === 'POST' && req.url === '/api/v1/ideas') {
          if (mode === 'refuse') return send(409, { ok: false, error: 'project_unavailable', message: 'That project is not hosted by this account. Nothing was saved.' });
          const had = ideas.get(body.client_id);
          if (had) return send(200, { ok: true, saved: true, duplicate: true, idea: had });
          const idea = { id: body.id, name: 'cut-by-voice', title: body.title, project_id: body.project_id || null };
          ideas.set(body.client_id, idea);
          return send(201, { ok: true, saved: true, duplicate: false, idea });
        }
        send(404, { ok: false, error: 'not_found' });
      });
    });
    stub.listen(port || 0, '127.0.0.1', () => { port = stub.address().port; resolve(); });
  });
}
const stop = () => new Promise((r) => stub.close(r));

before(async () => { seen = []; ideas = new Map(); mode = 'up'; await start(); });
after(async () => { if (stub.listening) await stop(); });
beforeEach(async () => {
  if (!stub.listening) await start();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'pending-ideas-'));
  env = { PURMEMO_SESSIONS_URL: `http://127.0.0.1:${port}`, PURMEMO_PENDING_DIR: dir };
  seen = []; ideas = new Map(); mode = 'up';
});
const call = () => createSessionsCall({ env, key: 'user-key' });
// The account is injected: on a signed-in machine the real default account would name the folder.
const FP = 'fp-of-user-key';
const note = (args) => createNoteIdea(call(), { env, account: () => 'default', fingerprint: FP })(args);
const resend = (account = 'default', fp = FP) => resendPending(account, call(), env, null, fp);
const waiting = () => listPending('default', env);

describe('note_idea: saved', () => {
  it('finds the project from the card id, notes the idea with the user\'s key, and leaves nothing pending', async () => {
    const r = await note({ idea: 'Cut by voice', note: 'Say where to cut.', words: 'what if I could just say where to cut', project_id: PROJECT });
    assert.match(r.content[0].text, /^✅ Idea saved to purmemo: "Cut by voice" \(cut-by-voice\), in project bauhaus\./);
    assert.equal(r.isError, undefined);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url.split('?')[0]}`), ['GET /api/v1/projects/resolve', 'POST /api/v1/ideas']);
    assert.ok(seen.every((s) => s.auth === 'Bearer user-key'));
    const sent = seen[1].body;
    assert.deepEqual([sent.title, sent.note, sent.words, sent.words_are, sent.project_id, sent.said_in.surface], ['Cut by voice', 'Say where to cut.', 'what if I could just say where to cut', 'noted', PROJECT, 'terminal_session']);
    assert.match(sent.client_id, /^idea-[0-9a-f-]{36}$/); assert.match(sent.id, /^[0-9a-f-]{36}$/);
    assert.ok(sent.said_in.machine, 'the machine it was said on');
    assert.deepEqual(waiting(), []);
  });

  it('by repository address; with nothing named it is unfiled; an unknown repository or an unreachable card id says so', async () => {
    assert.match((await note({ idea: 'A', repository: 'git@github.com:coladapo/bauhaus.git' })).content[0].text, /in project bauhaus/);
    assert.match((await note({ idea: 'B' })).content[0].text, /not filed under a project \(none was named\)/);
    assert.equal(seen.filter((s) => s.url.startsWith('/api/v1/projects/resolve')).length, 1, 'no project named = no lookup, and never a guess by name');
    assert.match((await note({ idea: 'C', repository: 'github.com/someone/else' })).content[0].text, /purmemo does not know this repository in this account yet/);
    const other = '99999999-9999-4999-8999-999999999999';
    assert.match((await note({ idea: 'D', project_id: other })).content[0].text, /meant for a project this account cannot reach/);
    assert.deepEqual([seen[seen.length - 1].body.meant_for, seen[seen.length - 1].body.project_id], [other, undefined]);
  });

  it('exact words only with the words AND the session they are in; otherwise a note of what was said, and it says so', async () => {
    await note({ idea: 'E', words: 'make the canvas quiet', exact_words: true, session_id: 'sess-9' });
    assert.deepEqual([seen[0].body.words_are, seen[0].body.said_in.session], ['his_exact', 'sess-9']);
    const r = await note({ idea: 'F', words: 'make the canvas quiet', exact_words: true });
    assert.equal(seen[1].body.words_are, 'noted');
    assert.match(r.content[0].text, /Kept as a note of what was said, not as exact words/);
  });

  it('noted into another signed-in account: only the surface and the fact that the session lives elsewhere are sent; not the machine, the session id or the other account\'s name', async () => {
    const r = await createNoteIdea(call(), { env, account: () => 'work@example.com', sessionElsewhere: true, fingerprint: FP })({ idea: 'Said at home, for work', words: 'exactly this', exact_words: true, session_id: 'home-session-1' });
    assert.deepEqual(seen[0].body.said_in, { surface: 'terminal_session', account: 'another-account' });
    assert.ok(!JSON.stringify(seen.map((x) => [x.url, x.body])).includes('home-session-1'), 'the session id never leaves in a request made as the other account');
    assert.equal(seen[0].body.words_are, 'noted');
    assert.match(r.content[0].text, /this session belongs to another account than the idea/);
    await note({ idea: 'Said on its own account' });
    assert.deepEqual([seen[1].body.said_in.account, typeof seen[1].body.said_in.machine], [undefined, 'string']);
  });

  it('saved only when purmemo says so and gives the idea back: a polite answer that is not that keeps the idea pending', async () => {
    for (const body of [{ ok: false }, { ok: true, saved: false }, { ok: true, saved: true }, {}]) {
      const fake = async (endpoint) => (endpoint.startsWith('/api/v1/ideas') ? body : { ok: true, answer: 'not_known' });
      const r = await createNoteIdea(fake, { env, account: () => 'default', fingerprint: FP })({ idea: `answer ${JSON.stringify(body)}` });
      assert.match(r.content[0].text, /NOT saved yet: purmemo did not answer \(purmemo answered without confirming/, JSON.stringify(body));
    }
    assert.equal(waiting().length, 4);
  });

  it('refuses bad input before anything is written', async () => {
    for (const args of [{}, { idea: '   ' }, { idea: 'x', said_in: 'carrier_pigeon' }, { idea: 'x', project_id: 'bauhaus' }]) {
      const r = await note(args); assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.deepEqual([seen.length, existsSync(join(dir, 'default'))], [0, false]);
    assert.ok(IDEA_SURFACES.includes('cosmo') && IDEA_SURFACES.includes('app_voice_note') && IDEA_SURFACES.includes('share_sheet') && IDEA_SURFACES.includes('bauhaus_conversation'));
  });
});

describe('note_idea: pending, honestly', () => {
  it('EXIT TEST: network off → noted → pending, never shown as saved → network on → saved exactly once', async () => {
    await stop(); // purmemo cannot be reached at all
    const r = await note({ idea: 'Cut by voice', words: 'what if I could just say where to cut', project_id: PROJECT });
    assert.match(r.content[0].text, /^⏳ NOT saved yet: purmemo did not answer/);
    assert.doesNotMatch(r.content[0].text, /✅|Idea saved/);
    assert.match(r.content[0].text, /Waiting on this device: 1\./);
    const held = waiting();
    assert.deepEqual([held.length, held[0].body.title, held[0].project_id, held[0].account], [1, 'Cut by voice', PROJECT, 'default']);
    const second = await note({ idea: 'A second one while offline' });
    assert.match(second.content[0].text, /Waiting on this device: 2\./);

    await start(); // purmemo is back
    const first = await resend();
    assert.deepEqual(first, { sent: 2, refused: 0, still: 0, other_sign_in: 0 });
    assert.deepEqual(waiting(), []);
    assert.equal(ideas.size, 2);
    // Sent again anyway (a sweep and a restart racing): the same capture ids, so still two ideas.
    const posts = seen.filter((x) => x.method === 'POST' && x.url === '/api/v1/ideas');
    assert.deepEqual(posts.map((p) => p.body.client_id), held.map((c) => c.client_id).concat(posts.slice(1).map((p) => p.body.client_id)).slice(0, posts.length));
    assert.equal(posts[0].body.client_id, held[0].client_id, 'the very capture id written before the network came back');
    for (const p of posts) { const again = await call()('/api/v1/ideas', { method: 'POST', body: JSON.stringify(p.body) }); assert.equal(again.duplicate, true); }
    assert.equal(ideas.size, 2, 'saved once each');
  });

  it('the next idea noted carries the waiting ones with it, oldest first', async () => {
    mode = 'down';
    for (const idea of ['one', 'two']) assert.match((await note({ idea })).content[0].text, /NOT saved yet/);
    mode = 'up';
    const r = await note({ idea: 'three' });
    assert.match(r.content[0].text, /^✅ Idea saved.*Also sent 2 idea\(s\) that had been waiting on this device\./s);
    assert.deepEqual([...ideas.values()].map((i) => i.title), ['three', 'one', 'two']);
    assert.deepEqual(waiting(), []);
  });

  it('a server error, a plan not confirmed and a missing sign-in all keep the idea pending; none loses it', async () => {
    mode = 'down';
    assert.match((await note({ idea: 'kept through a 503' })).content[0].text, /NOT saved yet/);
    mode = 'no-plan';
    assert.match((await note({ idea: 'kept through a 403' })).content[0].text, /NOT saved yet.*ideas are not switched on for this account yet/s);
    const keyless = await createNoteIdea(createSessionsCall({ env, key: null }), { env, account: () => 'default', fingerprint: FP })({ idea: 'kept with no sign-in' });
    assert.match(keyless.content[0].text, /NOT saved yet/);
    assert.equal(waiting().length, 3);
    assert.deepEqual(await resend(), { sent: 0, refused: 0, still: 1, other_sign_in: 0 }, 'still unreachable: it stops at the first and tries again later');
    assert.equal(waiting()[0].attempts, 1);
    const old = pendingSummary('default', env, Date.now() + 30 * 3600 * 1000);
    assert.deepEqual([old.count, old.oldest_hours >= 24, old.unreadable, old.other_sign_in], [3, true, 0, 0]);
  });

  it('a server that does not have the idea routes yet (a bare 404) is "could not ask": the idea stays pending, not refused', async () => {
    mode = 'no-routes';
    const r = await note({ idea: 'Before the routes are deployed', project_id: PROJECT });
    assert.match(r.content[0].text, /NOT saved yet/);
    assert.deepEqual([waiting().length, existsSync(join(dir, 'default', 'refused'))], [1, false]);
  });

  it("purmemo's own no: not saved, said plainly, and the words are kept on the device under refused/", async () => {
    mode = 'refuse';
    const r = await note({ idea: 'For a project of another account', project_id: PROJECT });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^❌ purmemo did not take this idea: That project is not hosted by this account\. Nothing was saved\.\. It is NOT saved\. It is kept on this device \(refused\)/);
    assert.deepEqual(waiting(), []);
    const kept = readdirSync(join(dir, 'default', 'refused'));
    assert.equal(kept.length, 1);
    assert.match(JSON.parse(readFileSync(join(dir, 'default', 'refused', kept[0]), 'utf8')).refused_because, /not hosted by this account/);
  });

  it('a capture is only ever sent with the sign-in it was made under, whatever the account is called on this machine', async () => {
    mode = 'down';
    await note({ idea: 'made under sign-in A' });
    mode = 'up'; seen = [];
    // The same folder, a different sign-in (the active profile was switched under a running connector).
    assert.deepEqual(await resend('default', 'fp-of-another-key'), { sent: 0, refused: 0, still: 0, other_sign_in: 1 });
    assert.equal(seen.length, 0, 'nothing was sent with the other sign-in');
    const said = await createNoteIdea(call(), { env, account: () => 'default', fingerprint: 'fp-of-another-key' })({ idea: 'made under sign-in B' });
    assert.match(said.content[0].text, /^✅.*1 idea\(s\) on this device were captured under a different sign-in and wait for it; they are not sent with this one\./s);
    assert.ok(seen.every((x) => x.method === 'GET' || x.body.title === 'made under sign-in B'), 'only its own capture went out');
    assert.deepEqual(waiting().map((c) => c.body.title), ['made under sign-in A']);
    assert.deepEqual(await resend(), { sent: 1, refused: 0, still: 0, other_sign_in: 0 });
    assert.equal(signInFingerprint('user-key'), signInFingerprint('user-key'));
    assert.notEqual(signInFingerprint('user-key'), signInFingerprint('user-key2'));
    assert.ok(!signInFingerprint('user-key').includes('user-key') && signInFingerprint(null) === null);
  });

  it('one account, one folder: two names never share one, and a name cannot climb out of the pending folder', async () => {
    const names = ['a!b@example.com', 'a_b@example.com', 'a.b@example.com', 'A_B@example.com', '../../etc', '..', '.', 'a/b', 'a~21~b@example.com'];
    const folders = names.map((n) => accountFolder(n));
    assert.equal(accountFolder('Adobe@ChrisOladapo.com'), 'adobe@chrisoladapo.com');
    assert.equal(new Set(folders.filter((f, i) => names[i].toLowerCase() !== 'a_b@example.com' || i === 1)).size, names.length - 1, 'only the two spellings of one address share a folder');
    for (const f of folders) { assert.doesNotMatch(f, /[\/\\]/); assert.ok(f !== '..' && f !== '.' && f.length > 0, f); }
    assert.equal(accountFolder(null), 'default');
    mode = 'down';
    await note({ idea: 'for the default account' });
    assert.deepEqual([listPending('default', env).length, listPending('work@example.com', env).length], [1, 0]);
    mode = 'up';
    assert.deepEqual(await resend('work@example.com'), { sent: 0, refused: 0, still: 0, other_sign_in: 0 }, "another account's pass never sees it");
    assert.equal(listPending('default', env).length, 1);
  });

  it('a crash between the two steps of a write does not strand the capture; a file that cannot be read is counted, never hidden', async () => {
    const folder = join(dir, 'default'); mkdirSync(folder, { recursive: true });
    const capture = { client_id: 'idea-crashed-mid-write', id: '11111111-1111-4111-8111-111111111111', account: 'default', sign_in: FP, created_at: new Date(Date.now() - 3600e3).toISOString(), attempts: 0, body: { title: 'Written, never renamed', said_in: { surface: 'terminal_session' } } };
    const orphan = join(folder, 'idea-crashed-mid-write.json.4242.a1b2c3d4e5f6.tmp');
    writeFileSync(orphan, JSON.stringify(capture));
    assert.deepEqual(readPending('default', env).captures, [], 'a write still in progress is left alone');
    const old = new Date(Date.now() - 5 * 60e3); utimesSync(orphan, old, old);
    assert.deepEqual(readPending('default', env).captures.map((c) => c.client_id), ['idea-crashed-mid-write']);
    assert.ok(existsSync(join(folder, 'idea-crashed-mid-write.json')) && !existsSync(orphan));
    writeFileSync(join(folder, 'idea-broken.json'), '{"client_id": "idea-broken", "body": {');
    const s2 = pendingSummary('default', env, Date.now(), FP);
    assert.deepEqual([s2.count, s2.unreadable], [1, 1]);
    const r = await note({ idea: 'the next idea says so' });
    assert.match(r.content[0].text, /^✅.*Also sent 1 idea\(s\).*1 file\(s\) in this device's pending folder could not be read; they are kept there and need a look\./s);
    assert.ok(existsSync(join(folder, 'idea-broken.json')), 'kept');
  });

  it('once the idea is saved the reply says saved, whatever then goes wrong with the waiting ones', async () => {
    const folder = join(dir, 'default'); mkdirSync(join(folder, 'idea-a-folder-not-a-file.json'), { recursive: true });
    const r = await note({ idea: 'Saved despite a broken queue' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /^✅ Idea saved to purmemo: "Saved despite a broken queue"/);
    assert.equal([...ideas.values()].filter((i) => i.title === 'Saved despite a broken queue').length, 1);
  });

  it('two writers on one capture never share a half-written file: every write lands whole', async () => {
    const capture = { client_id: 'idea-contended', id: '22222222-2222-4222-8222-222222222222', account: 'default', sign_in: FP, created_at: new Date().toISOString(), attempts: 0, body: { title: 'x'.repeat(2000), said_in: { surface: 'terminal_session' } } };
    await Promise.all(Array.from({ length: 40 }, (_, i) => new Promise((resolve) => setImmediate(() => { writePending('default', { ...capture, attempts: i, last_error: 'y'.repeat(i * 50) }, env); resolve(); }))));
    const got = readPending('default', env);
    assert.deepEqual([got.captures.length, got.unreadable, readdirSync(join(dir, 'default')).filter((f) => f.endsWith('.tmp'))], [1, [], []]);
  });
});

describe('note_idea: at connector start', () => {
  it('nothing waiting = no timer and no call', async () => {
    assert.equal(sendWaitingIdeasAtStart(1, env, call(), { account: () => 'default', fingerprint: FP }), null);
    assert.equal(seen.length, 0);
  });
  it('something waiting is sent a moment after start, with the sign-in the process started on and no other', async () => {
    mode = 'down';
    await note({ idea: 'waited through a restart' });
    await createNoteIdea(call(), { env, account: () => 'default', fingerprint: 'fp-of-another-key' })({ idea: 'made under another sign-in' });
    mode = 'up'; seen = [];
    const t = sendWaitingIdeasAtStart(5, env, call(), { account: () => 'default', fingerprint: FP });
    assert.ok(t, 'a timer was set');
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual([...ideas.values()].map((i) => i.title), ['waited through a restart']);
    assert.deepEqual(waiting().map((c) => c.body.title), ['made under another sign-in']);
  });
  it('never when switched off, never in hosted mode, never without a sign-in', async () => {
    mode = 'down'; await note({ idea: 'waiting' }); mode = 'up'; seen = [];
    const deps = { account: () => 'default', fingerprint: FP };
    assert.equal(sendWaitingIdeasAtStart(1, { ...env, PURMEMO_IDEAS_OFF: '1' }, call(), deps), null);
    assert.equal(sendWaitingIdeasAtStart(1, { ...env, PURMEMO_REMOTE: '1' }, call(), deps), null);
    assert.equal(sendWaitingIdeasAtStart(1, env, call(), { account: () => 'default', fingerprint: null }), null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 0);
  });
});

describe('note_idea: who sees it', () => {
  it("listed only for an account holding 'projects'; PURMEMO_IDEAS_OFF=1 hides it for everyone; it takes an account", () => {
    assert.equal(GATED_TOOLS.note_idea.feature, 'projects');
    assert.equal(isToolVisible('note_idea', {}, ['projects']), true);
    assert.equal(isToolVisible('note_idea', {}, ['deep', 'sessions_search']), false);
    assert.equal(isToolVisible('note_idea', {}, null), false);
    assert.equal(isToolVisible('note_idea', { PURMEMO_IDEAS_OFF: '1' }, ['projects']), false);
    assert.equal(isToolVisible('note_idea', { PURMEMO_REMOTE: '1' }, ['projects']), false, 'the hosted connector does not offer it yet');
    assert.ok(ACCOUNT_TOOLS.includes('note_idea'));
  });
  it('an idea is never lost to a lookup that did not answer: features unknown lets the capture run; known and missing refuses', () => {
    assert.deepEqual(CAPTURE_TOOLS, ['note_idea']);
    assert.equal(gatedToolResult('note_idea', {}, null), null);
    assert.match(gatedToolResult('note_idea', {}, ['deep']).content[0].text, /not part of your plan/);
    assert.match(gatedToolResult('note_idea', { PURMEMO_IDEAS_OFF: '1' }, ['projects']).content[0].text, /not available here/);
    assert.match(gatedToolResult('search_past_sessions', { PURMEMO_SESSIONS_BETA: '1' }, null).content[0].text, /Could not confirm/, 'other gated tools still fail closed');
  });
});

describe('note_idea: third review round', () => {
  const held = (extra = {}) => ({ client_id: 'idea-by-hand-0001', id: '33333333-3333-4333-8333-333333333333', account: 'default', sign_in: FP, created_at: new Date(Date.now() - 3600e3).toISOString(), attempts: 0, body: { title: 'Put there by hand', said_in: { surface: 'terminal_session' } }, ...extra });
  const put = (name, capture) => { const folder = join(dir, 'default'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, `${name}.json`), JSON.stringify(capture)); };

  it('the account a capture is for is the account whose sign-in sends it: a default switched under a running connector is refused, and nothing is written or sent', async () => {
    assert.deepEqual(accountForCapture(null, 'a@example.com'), { account: 'a@example.com' });
    assert.deepEqual(accountForCapture(null, null), { account: 'default' });
    assert.deepEqual(accountForCapture({ email: 'B@example.com', isDefault: false }, 'a@example.com'), { account: 'b@example.com' });
    assert.deepEqual(accountForCapture({ email: 'A@example.com', isDefault: true }, 'a@example.com'), { account: 'a@example.com' });
    assert.deepEqual(accountForCapture({ email: 'b@example.com', isDefault: true }, 'a@example.com'), { mismatch: true });
    assert.deepEqual(accountForCapture({ email: 'b@example.com', isDefault: true }, null), { mismatch: true });
    // Started as A; the machine's default was switched to B; the call names B "the default". The sign-in in use is still A's.
    const r = await createNoteIdea(call(), { env, fingerprint: FP, startedAs: 'a@example.com', scope: { email: 'b@example.com', isDefault: true } })({ idea: 'would have gone to the wrong account' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /NOT saved.*Restart the connector/s);
    assert.deepEqual([seen.length, existsSync(join(dir, accountFolder('b@example.com'))), existsSync(join(dir, accountFolder('a@example.com')))], [0, false, false]);
  });

  it('the account name is the one recorded by the step that loaded the sign-in, never one read at another moment; before that, "the default account" is refused', async () => {
    assert.deepEqual(startedAs(), { account: null, loaded: false }, 'nothing is assumed when the module is merely loaded');
    const before = await createNoteIdea(call(), { env, fingerprint: FP, scope: { email: 'a@example.com', isDefault: true } })({ idea: 'before the sign-in is loaded' });
    assert.match(before.content[0].text, /NOT saved/);
    signInLoadedFor('B@example.com'); // the sign-in that was loaded is B's, whatever the default was called a moment earlier or later
    assert.deepEqual(startedAs(), { account: 'b@example.com', loaded: true });
    const forA = await createNoteIdea(call(), { env, fingerprint: FP, scope: { email: 'a@example.com', isDefault: true } })({ idea: 'for A, on B\'s sign-in' });
    assert.match(forA.content[0].text, /NOT saved.*Restart the connector/s);
    assert.equal(seen.length, 0);
    const forB = await createNoteIdea(call(), { env, fingerprint: FP, scope: { email: 'b@example.com', isDefault: true } })({ idea: 'for B, on B\'s sign-in' });
    assert.match(forB.content[0].text, /^✅/);
    assert.ok(existsSync(join(dir, accountFolder('b@example.com'))) && !existsSync(join(dir, accountFolder('a@example.com'))));
  });

  it('a capture goes out only under the very sign-in it was made with: the key on the wire is checked, not only the label', async () => {
    const fpA = signInFingerprint('key-of-a'); const fpB = signInFingerprint('key-of-b');
    const asA = createSessionsCall({ env, key: 'key-of-a' }); const asB = createSessionsCall({ env, key: 'key-of-b' });
    mode = 'down';
    await createNoteIdea(asA, { env, account: () => 'default', fingerprint: fpA })({ idea: 'made by A' });
    mode = 'up'; seen = [];
    assert.deepEqual(await resendPending('default', asB, env, null, fpB), { sent: 0, refused: 0, still: 0, other_sign_in: 1 });
    await createNoteIdea(asB, { env, account: () => 'default', fingerprint: fpB })({ idea: 'made by B' });
    assert.deepEqual(await resendPending('default', asA, env, null, fpA), { sent: 1, refused: 0, still: 0, other_sign_in: 0 });
    const posts = seen.filter((x) => x.method === 'POST').map((x) => [x.body.title, x.auth]);
    assert.deepEqual(posts, [['made by B', 'Bearer key-of-b'], ['made by A', 'Bearer key-of-a']]);
  });

  it('a file that does not say which sign-in or which account it was made under is never sent; it stays and is counted', async () => {
    const { sign_in: _none, ...unsigned } = held();
    put('idea-by-hand-0001', unsigned);
    put('idea-by-hand-0002', held({ client_id: 'idea-by-hand-0002', account: 'someone-else@example.com' }));
    assert.deepEqual(await resend(), { sent: 0, refused: 0, still: 0, other_sign_in: 2 });
    assert.deepEqual([seen.length, waiting().length], [0, 2]);
  });

  it('a session of another account is never named to this one, whatever the file on the device holds', async () => {
    put('idea-by-hand-0001', held({ body: { title: 'Said at home, for work', said_in: { surface: 'terminal_session', account: 'home@example.com', session: 'session-account:home@example.com', machine: 'private-mac', memory: 'mem-1' } } }));
    assert.equal((await resend()).sent, 1);
    const sent = seen.find((x) => x.method === 'POST');
    assert.deepEqual(sent.body.said_in, { surface: 'terminal_session', account: 'another-account' });
    assert.ok(!/home@example|private-mac|session-account|mem-1/.test(JSON.stringify(sent.body)));
  });

  it('written to the device first, always: when that fails the idea is not sent, and the reply says so', async () => {
    writeFileSync(join(dir, 'not-a-folder'), 'x');
    const broken = { ...env, PURMEMO_PENDING_DIR: join(dir, 'not-a-folder') };
    const r = await createNoteIdea(createSessionsCall({ env: broken, key: 'user-key' }), { env: broken, account: () => 'default', fingerprint: FP })({ idea: 'nowhere to keep it' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /NOT saved: it could not be written to this device first, so it was not sent/);
    assert.doesNotMatch(r.content[0].text, /kept on this device/);
    assert.deepEqual([seen.length, ideas.size], [0, 0], 'nothing went out, so saying it again cannot make a second idea');
  });

  it('refused, and it cannot be set aside: the reply says where the words really are', async () => {
    const folder = join(dir, 'default'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'refused'), 'in the way');
    mode = 'refuse';
    const r = await note({ idea: 'refused with nowhere to put it' });
    assert.match(r.content[0].text, /NOT saved\. It is still on this device, among the waiting ideas/);
    assert.deepEqual(waiting().map((c) => c.body.title), ['refused with nowhere to put it'], 'and that is true');
  });

  it('offline, a file that cannot be read is still named', async () => {
    const folder = join(dir, 'default'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'idea-broken.json'), '{"client_id": "idea-bro');
    mode = 'down';
    const r = await note({ idea: 'noted while offline' });
    assert.match(r.content[0].text, /^⏳ NOT saved yet.*Waiting on this device: 1\. 1 file\(s\) in this device's pending folder could not be read; they are kept there and need a look\./s);
  });

  it('started right after a crash, with only a half-written capture: it looks again once that can be put back, and sends it', async () => {
    const folder = join(dir, 'default'); mkdirSync(folder, { recursive: true });
    const orphan = join(folder, 'idea-by-hand-0001.json.4242.a1b2c3d4e5f6.tmp');
    writeFileSync(orphan, JSON.stringify(held()));
    assert.deepEqual(readPending('default', env).captures, []);
    const t = sendWaitingIdeasAtStart(5, env, call(), { account: () => 'default', fingerprint: FP, orphanMs: 20 });
    assert.ok(t, 'a timer was set although nothing could be sent yet');
    const old = new Date(Date.now() - 5 * 60e3); utimesSync(orphan, old, old); // a minute passes
    await new Promise((r) => setTimeout(r, 1300));
    assert.deepEqual([[...ideas.values()].map((i) => i.title), waiting().length, existsSync(orphan)], [['Put there by hand'], 0, false]);
  });

  it('two connector processes writing one capture at the same moment: every read finds it whole, and no half-written file is left', async () => {
    const lib = fileURLToPath(new URL('../dist/lib/pending-ideas.js', import.meta.url));
    const script = `import { writePending } from ${JSON.stringify(lib)}; const env = { PURMEMO_PENDING_DIR: ${JSON.stringify(dir)} }; const w = process.argv[1];
      for (let i = 0; i < 300; i += 1) writePending('default', { client_id: 'idea-two-processes', id: '44444444-4444-4444-8444-444444444444', account: 'default', sign_in: 'fp', created_at: '2026-11-21T00:00:00.000Z', attempts: i, last_error: w.repeat(i * 20), body: { title: 'x'.repeat(4000), said_in: { surface: 'terminal_session' } } }, env);`;
    const run = (w) => new Promise((resolve, reject) => { const c = spawn(process.execPath, ['--input-type=module', '-e', script, w], { stdio: 'ignore' }); c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}`)))); });
    let reads = 0; let stop = false;
    const reader = (async () => { while (!stop) { const got = readPending('default', env); assert.deepEqual(got.unreadable, []); assert.ok(got.captures.length <= 1); reads += 1; await new Promise((r) => setImmediate(r)); } })();
    await Promise.all([run('a'), run('b')]); stop = true; await reader;
    const got = readPending('default', env);
    assert.ok(reads > 0);
    assert.deepEqual([got.captures.length, got.unreadable, readdirSync(join(dir, 'default')).filter((f) => f.endsWith('.tmp'))], [1, [], []]);
  });
});
