/**
 * Hosted connector, per-account next routing (2026-10-21). Boots the real
 * Express app from dist with live and next both mocked. The flag lives on the
 * account in next (GET /api/v1/read-routing/me): Chris's account is 'next',
 * another is 'live'. The connector prefetches the flag when it validates a key.
 * A read with a cached answer never waits; the first read for a key after a
 * restart waits for the lookup, bounded (COLD_WAIT_MS here), then falls back to
 * live (2026-11-11). next's 501 not_on_next marks a key live at once; the
 * kill file beats everything; every routed read lands in the trial file
 * without the query.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIVE = 'https://api.invalid', NEXT = 'https://next.invalid';
const KEYS = { pm_chris: { id: 'acct-chris', backend: 'next' }, pm_other: { id: 'acct-other', backend: 'live' }, pm_slow: { id: 'acct-slow', backend: 'next' },
  pm_twin: { id: 'acct-twin', backend: 'next' }, pm_late: { id: 'acct-late', backend: 'next' }, pm_err: { id: 'acct-err', backend: 'next' }, pm_sess: { id: 'acct-sess', backend: 'next' } };
const COLD_WAIT_MS = 300, LOOKUP_MS = 60;
let base, srv, killed = false, nextMode = 'ok', hits, authMeCalls, trialDir;
const realFetch = globalThis.fetch;
const env = { PURMEMO_READ_BASE_URL: NEXT };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  trialDir = mkdtempSync(join(tmpdir(), 'trial-'));
  process.env.PURMEMO_READ_TRIAL_LOG = join(trialDir, 'read-trial.jsonl');
  globalThis.fetch = async (url, init) => {
    const u = String(url); const bearer = (init?.headers?.Authorization || init?.headers?.authorization || '').replace('Bearer ', '');
    if (u.startsWith(base)) return realFetch(url, init);
    const acct = KEYS[bearer];
    if (u === `${LIVE}/api/v1/auth/me`) {
      authMeCalls++;
      return acct ? { ok: true, status: 200, json: async () => ({ user_id: acct.id, email: `${acct.id}@example.com` }), text: async () => '' }
                  : { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    }
    if (u === `${NEXT}/api/v1/read-routing/me`) {
      hits.routing.push(bearer);
      if (bearer === 'pm_slow') return new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }); // answers only when the connector's own 5 s limit cancels it
      if (bearer === 'pm_err') throw new TypeError('fetch failed');
      if (acct) await sleep(LOOKUP_MS); // a real lookup takes ~300 ms: never instant
      return acct ? { ok: true, status: 200, json: async () => ({ ok: true, user_id: acct.id, backend: acct.backend }), text: async () => '' }
                  : { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    }
    if (u === `${NEXT}/api/v10/mcp/tools/execute`) {
      hits.next.push({ bearer, body: JSON.parse(init.body) });
      if (nextMode === 'down') return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
      if (nextMode === 'throw') throw new TypeError('fetch failed');
      if (nextMode === 'not_on_next') return { ok: false, status: 501, json: async () => ({}), text: async () => JSON.stringify({ ok: false, error: 'not_on_next' }) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'from next' }] }), text: async () => '' };
    }
    if (u === `${LIVE}/api/v10/mcp/tools/execute`) {
      hits.live.push({ bearer, body: JSON.parse(init.body), headers: init.headers, hasSignal: Boolean(init.signal) });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'from live' }] }), text: async () => '' };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  const { startRemoteServer } = await import('../dist/remote/start.js');
  const { app } = await startRemoteServer({
    API_URL: LIVE, CLIENT_VERSION: '0.0.0-test', PLATFORM: 'test',
    TOOLS: [{ name: 'recall_memories', description: 'recall', inputSchema: { type: 'object' } }],
    RESOURCES: [], RESOURCE_TEMPLATES: [], PROMPTS: [], server: null,
    getResolvedApiKey: () => null, setResolvedApiKey: () => {}, resolveApiKey: async () => null, checkForUpdates: () => {},
    listen: false,
    readDeps: { env, killFileExists: () => killed, routingColdWaitMs: COLD_WAIT_MS },
  });
  await new Promise((resolve) => { srv = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { globalThis.fetch = realFetch; delete process.env.PURMEMO_READ_TRIAL_LOG; srv?.close(); });
beforeEach(() => { hits = { next: [], live: [], routing: [] }; authMeCalls = 0; killed = false; nextMode = 'ok'; });

const call = async (key, tool = 'recall_memories', args = { query: 'the secret question' }) => {
  const r = await realFetch(`${base}/mcp/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const text = await r.text();
  const data = JSON.parse(text.split('data: ')[1]);
  return { status: r.status, text: data.result?.content?.[0]?.text, data };
};
const trialLines = () => readdirSync(trialDir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(trialDir, n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const trialText = () => readdirSync(trialDir).map((n) => readFileSync(join(trialDir, n), 'utf8')).join('');

describe('hosted per-account routing', () => {
  it("Chris's key, first read after a restart (nothing cached): the read waits for the lookup and is served by next, with his own key", async () => {
    const r1 = await call('pm_chris');
    assert.equal(r1.status, 200); assert.equal(r1.text, 'from next', 'the first read must not go to live');
    assert.deepEqual(hits.routing, ['pm_chris'], 'one lookup, started at validation and awaited by the read');
    assert.equal(hits.next.length, 1); assert.equal(hits.next[0].bearer, 'pm_chris'); assert.equal(hits.live.length, 0);
    hits = { next: [], live: [], routing: [] };
    const r = await call('pm_chris');
    assert.equal(r.status, 200); assert.equal(r.text, 'from next');
    assert.equal(hits.next.length, 1); assert.equal(hits.next[0].bearer, 'pm_chris'); assert.equal(hits.next[0].body.tool, 'recall_memories');
    assert.equal(hits.live.length, 0); assert.equal(hits.routing.length, 0, 'cached: no second routing lookup');
    const t = trialLines().at(-1);
    assert.equal(t.served_by, 'next'); assert.equal(t.account, 'acct-chr'); assert.equal(t.mode, 'hosted');
    assert.ok(!trialText().includes('secret question'), 'the query never reaches the trial file');
  });
  it('another account (flag live): the identical live call, next untouched, nothing recorded', async () => {
    const first = await call('pm_other'); // nothing cached: waits for the lookup, which says live
    assert.equal(first.text, 'from live'); assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1); assert.deepEqual(hits.routing, ['pm_other']);
    const before = trialLines().length; hits = { next: [], live: [], routing: [] };
    const r = await call('pm_other');
    assert.equal(r.text, 'from live');
    assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
    const l = hits.live[0];
    assert.equal(l.bearer, 'pm_other'); assert.deepEqual(l.body, { tool: 'recall_memories', arguments: { query: 'the secret question' } });
    assert.equal(l.headers['X-MCP-Version'], '0.0.0-test'); assert.equal(l.headers['Content-Type'], 'application/json'); assert.ok(l.hasSignal);
    assert.equal(trialLines().length, before, 'accounts on live are not counted');
  });
  it('the wait is bounded: with next hanging on the flag, the first read answers from live after the bound, not after the 5 s lookup limit', async () => {
    const t0 = Date.now();
    const r = await call('pm_slow');
    const took = Date.now() - t0;
    assert.equal(r.text, 'from live'); assert.ok(took >= COLD_WAIT_MS - 20 && took < COLD_WAIT_MS + 700, `took ${took} ms`);
    assert.equal(hits.routing.length, 1); assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
    assert.equal(hits.live[0].bearer, 'pm_slow');
  });
  it('the routing endpoint failing never fails a read: live answers as soon as the lookup fails, and keeps answering', async () => {
    const t0 = Date.now();
    const r = await call('pm_err');
    assert.equal(r.status, 200); assert.equal(r.text, 'from live'); assert.ok(Date.now() - t0 < COLD_WAIT_MS, `took ${Date.now() - t0} ms`);
    assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
    const t1 = Date.now();
    assert.equal((await call('pm_err')).text, 'from live'); assert.ok(Date.now() - t1 < COLD_WAIT_MS, 'the failed lookup is remembered for a minute: no second wait');
    assert.equal(hits.routing.length, 1);
  });
  it('two first reads for one key at the same time share one lookup and are both served by next', async () => {
    const [a, b] = await Promise.all([call('pm_twin'), call('pm_twin')]);
    assert.equal(a.text, 'from next'); assert.equal(b.text, 'from next');
    assert.deepEqual(hits.routing, ['pm_twin']); assert.equal(hits.next.length, 2); assert.equal(hits.live.length, 0);
  });
  it('a cached answer is never waited for: once known, a read does not touch the routing endpoint', async () => {
    await call('pm_late'); hits = { next: [], live: [], routing: [] };
    const t0 = Date.now();
    assert.equal((await call('pm_late')).text, 'from next'); assert.ok(Date.now() - t0 < LOOKUP_MS, `took ${Date.now() - t0} ms`);
    assert.equal(hits.routing.length, 0);
  });
  it('PURMEMO_READ_BASE_DISABLED=1 and an unset PURMEMO_READ_BASE_URL beat a cached next answer', async () => {
    env.PURMEMO_READ_BASE_DISABLED = '1';
    try { const r = await call('pm_chris'); assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1); }
    finally { delete env.PURMEMO_READ_BASE_DISABLED; }
    const saved = env.PURMEMO_READ_BASE_URL; delete env.PURMEMO_READ_BASE_URL; hits = { next: [], live: [], routing: [] };
    try { const r = await call('pm_chris'); assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 0); assert.equal(hits.routing.length, 0, 'no lookup either'); }
    finally { env.PURMEMO_READ_BASE_URL = saved; }
    hits = { next: [], live: [], routing: [] };
    assert.equal((await call('pm_chris')).text, 'from next', 'back on: the cached answer still serves');
  });
  it('the kill file sends a flagged account to live too', async () => {
    killed = true;
    const r = await call('pm_chris');
    assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
  });
  it('when next answers 5xx or the network fails, the flagged account still gets live, and the fallback is counted with a reason', async () => {
    for (const mode of ['down', 'throw']) {
      nextMode = mode; hits = { next: [], live: [], routing: [] };
      const r = await call('pm_chris');
      assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 1); assert.equal(hits.live.length, 1);
      const t = trialLines().at(-1); assert.equal(t.served_by, 'live'); assert.ok(['HTTP 503', 'error'].includes(t.reason), t.reason);
    }
  });
  it("next's 501 not_on_next marks the key live at once: the next read does not touch next", async () => {
    nextMode = 'not_on_next';
    const r1 = await call('pm_chris'); assert.equal(r1.text, 'from live'); assert.equal(hits.next.length, 1);
    nextMode = 'ok'; hits = { next: [], live: [], routing: [] };
    const r2 = await call('pm_chris'); assert.equal(r2.text, 'from live'); assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
  });
  it('a live-only filter bypasses next even for a flagged account', async () => {
    const r = await call('pm_chris', 'recall_memories', { query: 'q', intent: 'decision' });
    assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 0);
  });
  it('a rejected key is still a 401 before any routing', async () => {
    const r = await realFetch(`${base}/mcp/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer pm_nobody' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall_memories', arguments: {} } }) });
    assert.equal(r.status, 401); assert.equal(hits.next.length + hits.live.length + hits.routing.length, 0);
  });
});
