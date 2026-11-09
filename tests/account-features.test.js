/**
 * Per-account tools (2026-11-09). Which gated tools a caller sees is decided by
 * the ACCOUNT's features (plan + invite grants, resolved by purmemo-next at
 * GET /api/v1/features), not by a process flag:
 *   what_changed          needs 'notebook'
 *   search_past_sessions  needs 'sessions_search' AND the switch PURMEMO_SESSIONS_BETA=1
 * A switch is a kill-switch (off hides for everyone; on never grants). Features
 * that cannot be confirmed = gated tools hidden and refused; the four core
 * tools never depend on the lookup.
 *
 * Three layers: the pure rules, the cache, the real hosted app (live and next
 * mocked), and the built local server over stdio with a signed-in account.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOLS, GATED_TOOLS, isToolListable, isToolVisible, visibleTools, gatedToolResult } from '../dist/lib/tool-visibility.js';
import { createFeaturesCache, featuresBaseUrl } from '../dist/lib/features.js';

const CHRIS = ['deep', 'notebook', 'remember', 'sessions_search'];
const FREE = ['remember'];
const tool = (name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { query: { type: 'string' }, entity: { type: 'string' } } } });
const ALL = [...CORE_TOOLS, 'what_changed', 'search_past_sessions'].map(tool);
const names = (tools) => tools.map((t) => t.name).sort();
const CORE = [...CORE_TOOLS].sort();

describe('the rules (pure)', () => {
  it('the core is four tools and needs no features; gated tools need their feature', () => {
    assert.deepEqual(CORE, ['get_memory_details', 'get_user_context', 'recall_memories', 'save_conversation']);
    assert.deepEqual(Object.keys(GATED_TOOLS).sort(), ['search_past_sessions', 'what_changed']);
    for (const t of CORE_TOOLS) for (const f of [null, [], FREE, CHRIS]) assert.equal(isToolVisible(t, {}, f), true);
    assert.equal(isToolVisible('what_changed', {}, CHRIS), true);
    assert.equal(isToolVisible('what_changed', {}, ['notebook']), true, 'the plan view alone is enough');
    assert.equal(isToolVisible('what_changed', {}, FREE), false);
    assert.equal(isToolVisible('what_changed', {}, null), false, 'unknown = hidden');
  });
  it('the sessions switch is a kill-switch: off hides it even for a granted account; on never grants', () => {
    const ON = { PURMEMO_SESSIONS_BETA: '1' };
    assert.equal(isToolListable('search_past_sessions', {}), false);
    assert.equal(isToolVisible('search_past_sessions', {}, CHRIS), false, 'switch off: hidden for everyone');
    assert.equal(isToolVisible('search_past_sessions', ON, CHRIS), true);
    assert.equal(isToolVisible('search_past_sessions', ON, FREE), false, 'switch on is not a grant');
    assert.equal(isToolVisible('search_past_sessions', ON, null), false);
  });
  it('the tools/list snapshot: Chris vs an ordinary free account vs unknown, hosted (switch unset) and local (switch on)', () => {
    assert.deepEqual(names(visibleTools(ALL, {}, FREE)), CORE);
    assert.deepEqual(names(visibleTools(ALL, {}, null)), CORE);
    assert.deepEqual(names(visibleTools(ALL, {}, CHRIS)), [...CORE, 'what_changed'].sort());
    const ON = { PURMEMO_SESSIONS_BETA: '1' };
    assert.deepEqual(names(visibleTools(ALL, ON, FREE)), CORE);
    const mine = visibleTools(ALL, ON, CHRIS);
    assert.deepEqual(names(mine), [...CORE, 'search_past_sessions', 'what_changed'].sort());
    assert.match(mine.find((t) => t.name === 'recall_memories').description, /use search_past_sessions\.$/);
    assert.doesNotMatch(visibleTools(ALL, ON, FREE).find((t) => t.name === 'recall_memories').description, /search_past_sessions/);
  });
  it('a direct call: entitled → runs (null); not entitled → "not part of your plan"; unknown → "could not confirm"; core → never blocked', () => {
    assert.equal(gatedToolResult('what_changed', {}, CHRIS), null);
    assert.match(gatedToolResult('what_changed', {}, FREE).content[0].text, /what_changed is not part of your plan/);
    assert.equal(gatedToolResult('what_changed', {}, FREE).isError, true);
    assert.match(gatedToolResult('what_changed', {}, null).content[0].text, /Could not confirm what your plan includes/);
    assert.match(gatedToolResult('search_past_sessions', {}, CHRIS).content[0].text, /not available here/);
    assert.equal(gatedToolResult('search_past_sessions', { PURMEMO_SESSIONS_BETA: '1' }, CHRIS), null);
    for (const t of CORE_TOOLS) assert.equal(gatedToolResult(t, {}, null), null);
  });
});

describe('the features cache', () => {
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  it('asks next with the caller\'s own key, caches a good answer, and tells unknown from "nothing"', async () => {
    let t = 0; const calls = [];
    const c = createFeaturesCache({ now: () => t, env: { PURMEMO_READ_BASE_URL: 'https://next.invalid/' }, fetchImpl: async (url, init) => { calls.push([url, init.headers.Authorization]); return res(200, { features: init.headers.Authorization === 'Bearer k-chris' ? CHRIS : FREE }); } });
    assert.equal(c.get('k-chris'), null, 'nothing known yet: unknown, and a lookup starts');
    assert.deepEqual(await c.resolve('k-chris'), CHRIS);
    assert.deepEqual(await c.resolve('k-free'), FREE);
    assert.deepEqual(calls[0], ['https://next.invalid/api/v1/features', 'Bearer k-chris']);
    const n = calls.length; assert.deepEqual(await c.resolve('k-chris'), CHRIS); assert.equal(calls.length, n, 'cached');
    t = 10 * 60 * 1000 + 1; assert.deepEqual(await c.resolve('k-chris'), CHRIS); await c.settle(); assert.equal(calls.length, n + 1, 'due: refreshed in the background');
    assert.equal(await c.resolve(''), null);
  });
  it('a failed lookup is UNKNOWN (null), retried after a minute; a failed refresh keeps the last good answer', async () => {
    let t = 0; let mode = 'down'; let n = 0;
    const c = createFeaturesCache({ now: () => t, fetchImpl: async () => { n++; if (mode === 'down') return res(503, {}); if (mode === 'throw') throw new Error('boom'); return res(200, { features: CHRIS }); } });
    assert.equal(await c.resolve('k'), null);
    assert.equal(await c.resolve('k'), null); assert.equal(n, 1, 'not asked again inside the minute');
    t = 60001; mode = 'ok'; assert.deepEqual(await c.resolve('k'), CHRIS);
    t += 10 * 60 * 1000 + 1; mode = 'throw';
    assert.deepEqual(await c.resolve('k'), CHRIS); await c.settle();
    assert.deepEqual(c.get('k'), CHRIS, 'next blinked: the last good answer stays');
    t += 25 * 60 * 60 * 1000; c.get('k'); await c.settle();
    assert.equal(c.get('k'), null, 'older than a day and still failing: unknown');
  });
  it('a slow lookup does not hold the caller past the wait: unknown now, known once it lands', async () => {
    let release;
    const c = createFeaturesCache({ fetchImpl: () => new Promise((r) => { release = () => r(res(200, { features: CHRIS })); }) });
    const started = Date.now();
    assert.equal(await c.resolve('k', 30), null);
    assert.ok(Date.now() - started < 1000);
    release(); await c.settle();
    assert.deepEqual(c.get('k'), CHRIS);
  });
  it('the base is the same one what_changed and session search use', () => {
    assert.equal(featuresBaseUrl({}), 'https://next.purmemo.ai');
    assert.equal(featuresBaseUrl({ PURMEMO_READ_BASE_URL: 'http://r/' }), 'http://r');
    assert.equal(featuresBaseUrl({ PURMEMO_NEXT_URL: 'http://n', PURMEMO_READ_BASE_URL: 'http://r' }), 'http://n');
  });
});

// ---- the real hosted app --------------------------------------------------------------------------------------
describe('hosted connector: one process, every account its own list', () => {
  const LIVE = 'https://api.invalid', NEXT = 'https://next.invalid';
  const KEYS = { pm_chris: { id: 'acct-chris', features: CHRIS }, pm_free: { id: 'acct-free', features: FREE }, pm_down: { id: 'acct-down', features: null } };
  const env = { PURMEMO_READ_BASE_URL: NEXT };
  const realFetch = globalThis.fetch;
  let base, srv, hits, prevBase;
  before(async () => {
    prevBase = process.env.PURMEMO_READ_BASE_URL; process.env.PURMEMO_READ_BASE_URL = NEXT; // the what_changed handler reads the process env
    globalThis.fetch = async (url, init) => {
      const u = String(url); const bearer = (init?.headers?.Authorization || init?.headers?.authorization || '').replace('Bearer ', '');
      if (u.startsWith(base)) return realFetch(url, init);
      const acct = KEYS[bearer];
      const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
      if (u === `${LIVE}/api/v1/auth/me`) return acct ? json(200, { user_id: acct.id }) : json(401, {});
      if (u === `${NEXT}/api/v1/features`) { hits.features.push(bearer); return acct?.features ? json(200, { ok: true, features: acct.features }) : json(acct ? 503 : 401, {}); }
      if (u === `${NEXT}/api/v1/read-routing/me`) return json(200, { backend: 'live' });
      if (u.startsWith(`${NEXT}/api/v1/entities`)) { hits.entities.push(bearer); return u.includes('/dossier') ? json(200, { claims: [], history: [], contradictions: [] }) : json(200, { entities: [{ id: 'e1', canonical_name: 'Door', current_claims: 1 }] }); }
      if (u === `${LIVE}/api/v10/mcp/tools/execute`) { hits.live.push(bearer); return json(200, { content: [{ type: 'text', text: 'from live' }] }); }
      return json(503, {});
    };
    const { startRemoteServer } = await import('../dist/remote/start.js');
    const { app } = await startRemoteServer({
      API_URL: LIVE, CLIENT_VERSION: '0.0.0-test', PLATFORM: 'test', TOOLS: ALL,
      RESOURCES: [], RESOURCE_TEMPLATES: [], PROMPTS: [], server: null,
      getResolvedApiKey: () => null, setResolvedApiKey: () => {}, resolveApiKey: async () => null, checkForUpdates: () => {},
      listen: false, readDeps: { env, killFileExists: () => false },
    });
    await new Promise((resolve) => { srv = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => { globalThis.fetch = realFetch; srv?.close(); if (prevBase === undefined) delete process.env.PURMEMO_READ_BASE_URL; else process.env.PURMEMO_READ_BASE_URL = prevBase; });
  beforeEach(() => { hits = { features: [], entities: [], live: [] }; delete env.PURMEMO_SESSIONS_BETA; });

  const post = async (key, method, params, extra = {}) => {
    const r = await realFetch(`${base}/mcp/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const text = await r.text();
    return { status: r.status, sid: r.headers.get('mcp-session-id'), data: text.includes('data: ') ? JSON.parse(text.split('data: ')[1]) : JSON.parse(text) };
  };
  const list = async (key, extra) => names((await post(key, 'tools/list', {}, extra)).data.result.tools);
  const call = async (key, name, args) => (await post(key, 'tools/call', { name, arguments: args })).data.result;

  it('tools/list snapshot (the hosted box leaves the sessions switch unset): a free account sees exactly the 4 core tools; Chris sees those + what_changed; nobody sees session search', async () => {
    assert.deepEqual(await list('pm_free'), CORE);
    assert.deepEqual(await list('pm_chris'), [...CORE, 'what_changed'].sort());
    assert.deepEqual(await list(null), CORE, 'anonymous: the core only');
    assert.deepEqual(await list('pm_not_a_key'), CORE, 'an unknown key: the core only');
  });
  it('a session lists for the account that opened it', async () => {
    const init = await post('pm_chris', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.ok(init.sid);
    assert.deepEqual(await list(null, { 'Mcp-Session-Id': init.sid }), [...CORE, 'what_changed'].sort());
  });
  it('with the sessions switch on, only the account holding the grant gets session search (on is not a grant)', async () => {
    env.PURMEMO_SESSIONS_BETA = '1';
    assert.deepEqual(await list('pm_chris'), [...CORE, 'search_past_sessions', 'what_changed'].sort());
    assert.deepEqual(await list('pm_free'), CORE);
  });
  it('a direct call to a gated tool by an account without it is refused in plain words and never reaches next\'s facts', async () => {
    const r = await call('pm_free', 'what_changed', { entity: 'Door' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /what_changed is not part of your plan/);
    assert.equal(hits.entities.length, 0);
    const s = await call('pm_free', 'search_past_sessions', { query: 'x' });
    assert.match(s.content[0].text, /not available here|not part of your plan/);
  });
  it('Chris\'s what_changed still runs', async () => {
    const r = await call('pm_chris', 'what_changed', { entity: 'Door' });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.deepEqual(hits.entities, ['pm_chris', 'pm_chris']);
  });
  it('when the features lookup fails: the core tools are listed and work as before; gated tools are hidden and say they could not confirm', async () => {
    assert.deepEqual(await list('pm_down'), CORE);
    const r = await call('pm_down', 'recall_memories', { query: 'anything' });
    assert.equal(r.content[0].text, 'from live');
    assert.deepEqual(hits.live, ['pm_down']);
    const w = await call('pm_down', 'what_changed', { entity: 'Door' });
    assert.match(w.content[0].text, /Could not confirm what your plan includes/);
    assert.equal(hits.entities.length, 0);
  });
});

// ---- the built local server over stdio, with a signed-in account ------------------------------------------------
describe('local connector: the signed-in account\'s features decide the list', () => {
  const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
  let next, nextUrl, mode;
  before(async () => {
    next = createServer((req, res) => {
      if (req.url === '/api/v1/features' && mode !== 'down') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, features: req.headers.authorization === 'Bearer k-chris' ? CHRIS : FREE }));
      }
      res.writeHead(503); res.end('{}');
    });
    await new Promise((r) => next.listen(0, '127.0.0.1', r));
    nextUrl = `http://127.0.0.1:${next.address().port}`;
  });
  after(() => next?.close());
  beforeEach(() => { mode = 'ok'; });

  async function listFor(key, extraEnv = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'purmemo-feat-'));
    // Sign the account in the way setup does: the real token store, pointed at a throwaway profile dir.
    const prev = process.env.PURMEMO_CONFIG_DIR; process.env.PURMEMO_CONFIG_DIR = dir;
    try { const TokenStore = (await import('../dist/auth/token-store.js')).default; await new TokenStore().saveToken({ access_token: key }); }
    finally { if (prev === undefined) delete process.env.PURMEMO_CONFIG_DIR; else process.env.PURMEMO_CONFIG_DIR = prev; }
    const env = { PATH: process.env.PATH, HOME: dir, PURMEMO_CONFIG_DIR: dir, PURMEMO_NEXT_URL: nextUrl, PURMEMO_API_URL: 'http://127.0.0.1:9', NODE_ENV: 'production', ...extraEnv };
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = ''; let err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr: ${err.slice(-400)}`)); }, 15000);
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.stdout.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) { clearTimeout(timer); child.kill(); resolve(msg.result.tools); }
        }
      });
      child.on('error', reject);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    });
  }

  it('Chris\'s local connector (sessions switch on) still lists search_past_sessions and what_changed', async () => {
    const tools = await listFor('k-chris', { PURMEMO_SESSIONS_BETA: '1' });
    assert.deepEqual(names(tools), [...CORE, 'search_past_sessions', 'what_changed'].sort());
    assert.match(tools.find((t) => t.name === 'recall_memories').description, /use search_past_sessions\.$/);
  });
  it('an ordinary account on the same build, same switch: the four core tools', async () => {
    assert.deepEqual(names(await listFor('k-free', { PURMEMO_SESSIONS_BETA: '1' })), CORE);
  });
  it('next not answering at start: the four core tools are listed at once (gated ones stay hidden until the answer is known)', async () => {
    mode = 'down';
    assert.deepEqual(names(await listFor('k-chris', { PURMEMO_SESSIONS_BETA: '1' })), CORE);
  });
});
