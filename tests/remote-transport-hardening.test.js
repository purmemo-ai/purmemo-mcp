/**
 * Remote server hardening (2026-10-16): the unauthenticated HTTP+SSE transport
 * is retired with 410, the OAuth pages can no longer reflect attacker input,
 * and the supported Streamable HTTP path still answers. Boots the real Express
 * app from dist with stub deps and no network (fetch is mocked).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

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
  });  it('standard base64 params survive both the href and the form', async () => {
    const r = await local('/login?params=' + encodeURIComponent('abc+/='));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('?params=abc%2B%2F%3D"'), 'href is URL-encoded');
    assert.ok(html.includes('value="abc+/="'), 'hidden input carries the raw value');
  });
  it('a failed sign-in bounces back with params URL-encoded', async () => {
    const r = await local('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'a@b.c', password: 'x', params: 'abc+/=' }).toString() });
    assert.equal(r.status, 302);
    assert.ok(r.headers.get('location').startsWith('/login?params=abc%2B%2F%3D&error='), r.headers.get('location'));
  });
});

describe('/mcp advertised path', () => {
  it('GET /mcp reaches the real stream handler (401 without auth, not 404)', async () => {
    const r = await local('/mcp', { headers: { Accept: 'text/event-stream' } });
    assert.equal(r.status, 401);
  });
  it('DELETE /mcp reaches the real session handler (400 without a session id, not 404)', async () => {
    const r = await local('/mcp', { method: 'DELETE' });
    assert.equal(r.status, 400);
  });
});

describe('signed OAuth state', () => {
  const params = Buffer.from(JSON.stringify({ client_id: 'c', redirect_uri: 'https://claude.ai/cb', code_challenge: 'x', code_challenge_method: 'S256' })).toString('base64');
  const stateFromLogin = async () => {
    const r = await local('/oauth/google/login?params=' + encodeURIComponent(params));
    assert.equal(r.status, 302);
    return new URL(r.headers.get('location')).searchParams.get('state');
  };
  it('a state minted by our login redirect completes the callback', async () => {
    const state = await stateFromLogin();
    assert.match(state, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'payload.signature');
    const r = await local('/oauth/callback?' + new URLSearchParams({ token: 'pm_test_key', state }));
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('window.location.href = "https://claude.ai/cb?code=code_'));
  });
  it('a tampered or self-minted state is refused', async () => {
    const state = await stateFromLogin();
    const [payload, sig] = state.split('.');
    const tampered = payload.slice(0, -2) + (payload.endsWith('A') ? 'BB' : 'AA') + '.' + sig;
    for (const bad of [tampered, payload, payload + '.' + 'x'.repeat(43),
      Buffer.from(JSON.stringify({ id: 'evil', params, provider: 'google' })).toString('base64url')]) {
      const r = await local('/oauth/callback?' + new URLSearchParams({ token: 'pm_test_key', state: bad }));
      assert.equal(r.status, 400, `expected 400 for ${bad.slice(0, 20)}…`);
    }
  });
});

describe('/oauth/callback', () => {
  it('reflects a provider error as plain text, never HTML', async () => {
    const r = await local('/oauth/callback?error=' + encodeURIComponent('<script>alert(1)</script>'));
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.ok(!(await r.text()).includes('<script>'));
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
  });  it("a redirect_uri containing $' cannot corrupt the emitted script", async () => {
    const session = Buffer.from('pm_test_key').toString('base64');
    const r = await local('/oauth/authorize?' + q({ redirect_uri: "https://claude.ai/cb$'x", session }));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes(`window.location.href = "https://claude.ai/cb$'x?code=code_`), 'URL emitted verbatim inside the literal');
    const script = html.split('<script>').pop().split('</script>')[0];
    assert.doesNotThrow(() => new Function(script), 'the success script must still compile');
  });
  it('end to end: the code minted on the success page exchanges at /oauth/token with the exact redirect_uri the client sent', async () => {
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://localhost:80/cb'; // WHATWG would normalise this to http://localhost/cb
    const session = Buffer.from('pm_test_key').toString('base64');
    const page = await (await local('/oauth/authorize?' + new URLSearchParams({ client_id: 'claude-e2e', code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirect, state: 'st', session }))).text();
    const code = page.match(/code=(code_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code, 'a code is on the page');
    const token = await local('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: 'claude-e2e' }) });
    assert.equal(token.status, 200, await token.clone().text());
    assert.equal((await token.json()).access_token, 'pm_test_key');
    const replay = await local('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: 'claude-e2e' }) });
    assert.equal(replay.status, 400, 'codes are single use');
  });
});
