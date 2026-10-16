/**
 * Remote server hardening (2026-10-16): the unauthenticated HTTP+SSE transport
 * is retired with 410, the OAuth pages can no longer reflect attacker input,
 * and the supported Streamable HTTP path still answers. Boots the real Express
 * app from dist with stub deps and no network (fetch is mocked).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

let base, srv;
const realFetch = globalThis.fetch;
const local = (path, init) => realFetch(base + path, { redirect: 'manual', ...init });

before(async () => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, init);
    if (u.endsWith('/api/v1/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'test@example.com' }), text: async () => '' };
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  const { startRemoteServer } = await import('../dist/remote/start.js');
  const { app } = await startRemoteServer({
    API_URL: 'https://api.invalid', CLIENT_VERSION: '0.0.0-test', PLATFORM: 'test',
    TOOLS: [{ name: 'recall_memories', description: 'recall\nmore', inputSchema: { type: 'object' } }],
    RESOURCES: [], RESOURCE_TEMPLATES: [], PROMPTS: [], server: null,
    getResolvedApiKey: () => null, setResolvedApiKey: () => {}, resolveApiKey: async () => null, checkForUpdates: () => {},
    listen: false,
  });
  await new Promise((resolve) => { srv = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { globalThis.fetch = realFetch; srv?.close(); });

describe('retired HTTP+SSE transport', () => {
  for (const [method, path] of [['GET', '/sse'], ['GET', '/mcp/sse'], ['GET', '/sse/'], ['POST', '/messages?sessionId=abc']]) {
    it(`${method} ${path} → 410 with a migration pointer, never a live stream`, async () => {
      const r = await local(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 410);
      assert.equal(r.headers.get('location'), '/mcp/messages');
      const j = await r.json();
      assert.equal(j.error, 'transport_retired');
      assert.equal(j.endpoint, '/mcp/messages');
    });
  }
  it('discovery no longer advertises sse', async () => {
    const health = await (await local('/health')).json();
    assert.ok(!health.service_info.capabilities.includes('sse'));
    assert.equal(typeof health.active_connections, 'number');
    const wk = await (await local('/.well-known/mcp', { headers: { host: 'mcp.example' } })).json();
    assert.ok(!wk.transports.some((t) => t.type === 'sse'));
    const root = await (await local('/')).json();
    assert.equal(root.endpoints.sse, undefined);
    const manifest = await (await local('/.well-known/mcp-manifest.json')).json();
    assert.equal(manifest.endpoints.sse, undefined);
  });
  it('Streamable HTTP still answers: tools/list is public, tools/call needs auth', async () => {
    const list = await local('/mcp/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).result.tools[0].name, 'recall_memories');
    const call = await local('/mcp/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall_memories', arguments: {} } }) });
    assert.equal(call.status, 401);
  });
});

describe('/login reflects nothing it did not mint', () => {
  it('refuses params that are not base64/base64url', async () => {
    const r = await local('/login?params=' + encodeURIComponent('"><script>alert(1)</script>'));
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes('<script>alert'));
  });
  it('serves a normal params blob verbatim in both forms', async () => {
    const r = await local('/login?params=eyJjbGllbnRfaWQiOiJ4In0');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('value="eyJjbGllbnRfaWQiOiJ4In0"'));
    assert.ok(html.includes('/oauth/google/login?params=eyJjbGllbnRfaWQiOiJ4In0"'));
  });
});

describe('/oauth/authorize redirect handling', () => {
  const q = (o) => new URLSearchParams({ client_id: 'claude-test', code_challenge: 'abc', ...o }).toString();
  it('rejects javascript:, http-to-internet and relative redirect_uri', async () => {
    for (const bad of ['javascript:alert(1)', 'http://evil.example/cb', '/cb', 'data:text/html,x']) {
      const r = await local('/oauth/authorize?' + q({ redirect_uri: bad }));
      assert.equal(r.status, 400, `expected 400 for ${bad}`);
    }
  });
  it('sends an unauthenticated user to /login carrying only our own params blob', async () => {
    const r = await local('/oauth/authorize?' + q({ redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }));
    assert.equal(r.status, 302);
    const loc = r.headers.get('location');
    assert.ok(loc.startsWith('/login?params='));
    assert.match(loc.slice('/login?params='.length), /^[A-Za-z0-9_-]+$/);
  });
  it('the success page cannot be broken out of via state (or redirect_uri)', async () => {
    const evilState = '"</script><script>alert(1)</script>';
    const session = Buffer.from('pm_test_key').toString('base64');
    const r = await local('/oauth/authorize?' + q({ redirect_uri: 'https://claude.ai/cb', state: evilState, session }));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!html.includes('</script><script>alert'), 'raw state must not reach the page');
    assert.ok(html.includes('window.location.href = "https://claude.ai/cb?code=code_'), 'callback is emitted as a JSON string literal');
    assert.ok(html.includes('&state=%22%3C%2Fscript%3E'), 'state is URL-encoded into the callback');
  });
});
