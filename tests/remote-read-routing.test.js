/**
 * Hosted connector, per-account next routing (2026-10-21). Boots the real
 * Express app from dist with live and next both mocked. Chris's key is served
 * by next; another account's key takes the identical live call; the kill switch
 * sends everyone to live; a next failure falls back to live; every routed read
 * lands in the trial file without the query.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIVE = 'https://api.invalid', NEXT = 'https://next.invalid';
const KEYS = { pm_chris: 'acct-chris', pm_other: 'acct-other' };
let base, srv, killed = false, nextMode = 'ok', hits, authMeCalls, trialFile;
const realFetch = globalThis.fetch;
const env = { PURMEMO_READ_BASE_URL: NEXT, PURMEMO_NEXT_ACCOUNTS: 'acct-chris', PURMEMO_NEXT_ACCOUNTS_FILE: '/nonexistent/next-accounts.txt' };

before(async () => {
  trialFile = join(mkdtempSync(join(tmpdir(), 'trial-')), 'read-trial.jsonl');
  process.env.PURMEMO_READ_TRIAL_LOG = trialFile;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const bearer = (init?.headers?.Authorization || init?.headers?.authorization || '').replace('Bearer ', '');
    if (u.startsWith(base)) return realFetch(url, init);
    if (u === `${LIVE}/api/v1/auth/me`) {
      authMeCalls++;
      const id = KEYS[bearer];
      return id ? { ok: true, status: 200, json: async () => ({ user_id: id, email: `${id}@example.com` }), text: async () => '' }
                : { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    }
    if (u === `${NEXT}/api/v10/mcp/tools/execute`) {
      hits.next.push({ bearer, body: JSON.parse(init.body) });
      if (nextMode === 'down') return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
      if (nextMode === 'throw') throw new TypeError('fetch failed');
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
    readDeps: { env, killFileExists: () => killed, accounts: { env, statMtime: () => null } },
  });
  await new Promise((resolve) => { srv = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { globalThis.fetch = realFetch; delete process.env.PURMEMO_READ_TRIAL_LOG; srv?.close(); });
beforeEach(() => { hits = { next: [], live: [] }; authMeCalls = 0; killed = false; nextMode = 'ok'; });

const call = async (key, tool = 'recall_memories', args = { query: 'the secret question' }) => {
  const r = await realFetch(`${base}/mcp/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const text = await r.text();
  const data = JSON.parse(text.split('data: ')[1]);
  return { status: r.status, text: data.result?.content?.[0]?.text, data };
};
const trialLines = () => (existsSync(trialFile) ? readFileSync(trialFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('hosted per-account routing', () => {
  it("Chris's key: served by next with his own key, live never called for the read", async () => {
    const r = await call('pm_chris');
    assert.equal(r.status, 200); assert.equal(r.text, 'from next');
    assert.equal(hits.next.length, 1); assert.equal(hits.next[0].bearer, 'pm_chris'); assert.equal(hits.next[0].body.tool, 'recall_memories');
    assert.equal(hits.live.length, 0);
    assert.equal(authMeCalls, 1, 'one /auth/me for validation; the account id came from its body, no second call');
    const t = trialLines().at(-1);
    assert.equal(t.served_by, 'next'); assert.equal(t.account, 'acct-chr'); assert.equal(t.mode, 'hosted');
    assert.ok(!readFileSync(trialFile, 'utf8').includes('secret question'), 'the query never reaches the trial file');
  });
  it('another account: the identical live call, next untouched, nothing recorded', async () => {
    const before = trialLines().length;
    const r = await call('pm_other');
    assert.equal(r.text, 'from live');
    assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
    const l = hits.live[0];
    assert.equal(l.bearer, 'pm_other'); assert.deepEqual(l.body, { tool: 'recall_memories', arguments: { query: 'the secret question' } });
    assert.equal(l.headers['X-MCP-Version'], '0.0.0-test'); assert.equal(l.headers['Content-Type'], 'application/json'); assert.ok(l.hasSignal);
    assert.equal(trialLines().length, before, 'unlisted accounts are not counted');
  });
  it('the kill file sends a listed account to live too', async () => {
    killed = true;
    const r = await call('pm_chris');
    assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 0); assert.equal(hits.live.length, 1);
  });
  it('when next answers 5xx or the network fails, the listed account still gets live, and the fallback is counted with a reason', async () => {
    for (const mode of ['down', 'throw']) {
      nextMode = mode; hits = { next: [], live: [] };
      const r = await call('pm_chris');
      assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 1); assert.equal(hits.live.length, 1);
      const t = trialLines().at(-1); assert.equal(t.served_by, 'live'); assert.ok(['HTTP 503', 'error'].includes(t.reason), t.reason);
    }
  });
  it('a live-only filter and a non-read tool bypass next even for a listed account', async () => {
    const r = await call('pm_chris', 'recall_memories', { query: 'q', intent: 'decision' });
    assert.equal(r.text, 'from live'); assert.equal(hits.next.length, 0);
  });
  it('a rejected key is still a 401 before any routing', async () => {
    const r = await realFetch(`${base}/mcp/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer pm_nobody' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall_memories', arguments: {} } }) });
    assert.equal(r.status, 401); assert.equal(hits.next.length + hits.live.length, 0);
  });
});
