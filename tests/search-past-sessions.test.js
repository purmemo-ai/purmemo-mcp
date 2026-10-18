/**
 * search_past_sessions (beta, 2026-10-18): POSTs {tool:'search_past_sessions',
 * arguments:{query, limit}} to purmemo-next's /api/v10/mcp/tools/execute with
 * the user's key. No live fallback — failures come back as a plain message.
 * Exercised against the built dist and a real local stub HTTP server.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createSessionsCall, sessionsBaseUrl, SESSIONS_DEFAULT_URL } from '../dist/lib/api-client.js';
import { createSearchPastSessions } from '../dist/tools/sessions.js';

let stub; let base; let seen = []; let reply = { status: 200, body: { content: [{ type: 'text', text: 'session 2026-10-01 · clo-mini · purmemo-next' }] } };

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${stub.address().port}`;
});
after(() => stub.close());

const handler = (env, key = 'user-key') => createSearchPastSessions(createSessionsCall({ env, key }));

describe('sessionsBaseUrl', () => {
  it('read base first, then PURMEMO_SESSIONS_URL, then next.purmemo.ai', () => {
    assert.equal(sessionsBaseUrl({ PURMEMO_READ_BASE_URL: 'http://a/', PURMEMO_SESSIONS_URL: 'http://b' }), 'http://a');
    assert.equal(sessionsBaseUrl({ PURMEMO_SESSIONS_URL: 'http://b/' }), 'http://b');
    assert.equal(sessionsBaseUrl({}), SESSIONS_DEFAULT_URL);
    assert.equal(SESSIONS_DEFAULT_URL, 'https://next.purmemo.ai');
  });
});

describe('search_past_sessions request shape', () => {
  it('POSTs the tool call to the execute endpoint with the user key and the default limit 6', async () => {
    seen = []; reply = { status: 200, body: { content: [{ type: 'text', text: 'session window' }] } };
    const out = await handler({ PURMEMO_SESSIONS_URL: base })({ query: '  why we moved the database ' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/api/v10/mcp/tools/execute');
    assert.equal(seen[0].auth, 'Bearer user-key');
    assert.equal(seen[0].type, 'application/json');
    assert.deepEqual(seen[0].body, { tool: 'search_past_sessions', arguments: { query: 'why we moved the database', limit: 6 } });
    assert.equal(out.content[0].text, 'session window');
    assert.notEqual(out.isError, true);
  });
  it('uses PURMEMO_READ_BASE_URL when set, and caps limit at 12', async () => {
    seen = []; reply = { status: 200, body: { content: [{ type: 'text', text: 'ok' }] } };
    await handler({ PURMEMO_READ_BASE_URL: base, PURMEMO_SESSIONS_URL: 'http://127.0.0.1:9' })({ query: 'q', limit: 50 });
    assert.equal(seen.length, 1); assert.equal(seen[0].body.arguments.limit, 12);
  });
  it('needs a query and makes no call without one', async () => {
    seen = [];
    const out = await handler({ PURMEMO_SESSIONS_URL: base })({ query: '   ' });
    assert.equal(out.isError, true); assert.match(out.content[0].text, /needs a query/); assert.equal(seen.length, 0);
  });
});

describe('search_past_sessions failures are plain, with no live fallback', () => {
  it('501 from next → "not switched on yet", pointing at recall_memories', async () => {
    seen = []; reply = { status: 501, body: { ok: false, error: 'not_supported_on_next' } };
    const out = await handler({ PURMEMO_SESSIONS_URL: base })({ query: 'q' });
    assert.equal(seen.length, 1); assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not switched on for your account yet/); assert.match(out.content[0].text, /recall_memories still works/);
  });
  it('5xx → server error, not your account', async () => {
    reply = { status: 503, body: {} };
    const out = await handler({ PURMEMO_SESSIONS_URL: base })({ query: 'q' });
    assert.match(out.content[0].text, /server error \(HTTP 503\)/);
  });
  it('401 → setup problem', async () => {
    reply = { status: 401, body: { detail: 'bad key' } };
    const out = await handler({ PURMEMO_SESSIONS_URL: base })({ query: 'q' });
    assert.match(out.content[0].text, /not an outage/);
  });
  it('unreachable → could not reach', async () => {
    const out = await handler({ PURMEMO_SESSIONS_URL: 'http://127.0.0.1:9' })({ query: 'q' });
    assert.equal(out.isError, true); assert.match(out.content[0].text, /Could not reach purmemo|fetch failed/i);
  });
  it('no key → setup problem, no call made', async () => {
    seen = [];
    const out = await handler({ PURMEMO_SESSIONS_URL: base }, null)({ query: 'q' });
    assert.match(out.content[0].text, /not an outage/); assert.equal(seen.length, 0);
  });
});
