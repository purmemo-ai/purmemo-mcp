/**
 * note_idea (2026-11-21): one call notes an idea in purmemo-next's idea records. The capture is written to the
 * pending file on the device first; the reply says saved, pending or refused and never more than is true; a
 * capture sent twice carries the same id so it can never become two ideas.
 * Exercised against the built dist and a real local stub HTTP server that can be switched off.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionsCall } from '../dist/lib/api-client.js';
import { createNoteIdea, resendPending, sendWaitingIdeasAtStart, IDEA_SURFACES } from '../dist/tools/ideas.js';
import { listPending, pendingSummary, accountFolder } from '../dist/lib/pending-ideas.js';
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
const note = (args) => createNoteIdea(call(), { env, account: () => 'default' })(args);
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

  it('noted into another signed-in account: purmemo is told the session lives elsewhere, and the machine is not sent', async () => {
    await createNoteIdea(call(), { env, account: () => 'work@example.com', sessionElsewhere: true })({ idea: 'Said at home, for work', session_id: 'home-session-1' });
    const where = seen[0].body.said_in;
    assert.match(where.account, /^session-account:/);
    assert.deepEqual([where.machine, where.session, where.surface], [undefined, 'home-session-1', 'terminal_session']);
    await note({ idea: 'Said on its own account' });
    assert.deepEqual([seen[1].body.said_in.account, typeof seen[1].body.said_in.machine], [undefined, 'string']);
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
    const first = await resendPending('default', call(), env);
    assert.deepEqual(first, { sent: 2, refused: 0, still: 0 });
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
    const keyless = await createNoteIdea(createSessionsCall({ env, key: null }), { env, account: () => 'default' })({ idea: 'kept with no sign-in' });
    assert.match(keyless.content[0].text, /NOT saved yet/);
    assert.equal(waiting().length, 3);
    assert.deepEqual(await resendPending('default', call(), env), { sent: 0, refused: 0, still: 1 }, 'still unreachable: it stops at the first and tries again later');
    assert.equal(waiting()[0].attempts, 1);
    const old = pendingSummary('default', env, Date.now() + 30 * 3600 * 1000);
    assert.deepEqual([old.count, old.oldest_hours >= 24], [3, true]);
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

  it('a capture belongs to the account it was made for: each account has its own folder', async () => {
    assert.equal(accountFolder('Adobe@ChrisOladapo.com'), 'adobe@chrisoladapo.com');
    assert.doesNotMatch(accountFolder('../../etc'), /\//);
    assert.equal(accountFolder(null), 'default');
    mode = 'down';
    await note({ idea: 'for the default account' });
    assert.deepEqual([listPending('default', env).length, listPending('work@example.com', env).length], [1, 0]);
    mode = 'up';
    assert.deepEqual(await resendPending('work@example.com', call(), env), { sent: 0, refused: 0, still: 0 }, "another account's pass never sends it");
    assert.equal(listPending('default', env).length, 1);
  });
});

describe('note_idea: at connector start', () => {
  it('nothing waiting = no timer and no call; something waiting is sent a moment after start; never in remote mode', async () => {
    assert.equal(sendWaitingIdeasAtStart(1, env, call()), null);
    assert.equal(seen.length, 0);
    assert.equal(sendWaitingIdeasAtStart(1, { ...env, PURMEMO_IDEAS_OFF: '1' }, call()), null);
  });
});

describe('note_idea: who sees it', () => {
  it("listed only for an account holding 'projects'; PURMEMO_IDEAS_OFF=1 hides it for everyone; it takes an account", () => {
    assert.equal(GATED_TOOLS.note_idea.feature, 'projects');
    assert.equal(isToolVisible('note_idea', {}, ['projects']), true);
    assert.equal(isToolVisible('note_idea', {}, ['deep', 'sessions_search']), false);
    assert.equal(isToolVisible('note_idea', {}, null), false);
    assert.equal(isToolVisible('note_idea', { PURMEMO_IDEAS_OFF: '1' }, ['projects']), false);
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
