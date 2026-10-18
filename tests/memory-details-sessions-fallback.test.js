/**
 * get_memory_details → sessions base (2026-10-18). search_past_sessions ids live
 * only on purmemo-next; when live says "not found" and the sessions beta is on
 * (and no read base), the same id is retried on the sessions base. Two real
 * local stub servers stand in for live and next; the built dist runs unmocked.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { initApiClient } from '../dist/lib/api-client.js';
import { handleGetMemoryDetails, initHandlers } from '../dist/tools/handlers.js';

const ID = '004786fe-37ee-4650-bb2e-471700413c81';
let live, next, liveHits, nextHits, liveReply, nextReply;

function stub(onHit, reply) {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      onHit({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const r = reply();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const notFound = { status: 200, body: { content: [{ type: 'text', text: `Memory ${ID} not found.` }], isError: true } };
const found = { status: 200, body: { content: [{ type: 'text', text: 'SESSION PART: the whole window' }] } };

const saved = {};
before(async () => {
  live = stub((h) => liveHits.push(h), () => liveReply);
  next = stub((h) => nextHits.push(h), () => nextReply);
  const liveUrl = await listen(live); const nextUrl = await listen(next);
  initApiClient({ apiUrl: liveUrl, resolveApiKey: () => 'user-key', clientVersion: '0', installMethod: 'test', platform: 'test' });
  initHandlers({ platform: 'test', getLastRecallIds: () => [], setLastRecallIds: () => {}, readCurrentSessionId: () => null });
  for (const k of ['PURMEMO_SESSIONS_BETA', 'PURMEMO_SESSIONS_URL', 'PURMEMO_READ_BASE_URL']) saved[k] = process.env[k];
  process.env.PURMEMO_SESSIONS_URL = nextUrl;
  delete process.env.PURMEMO_READ_BASE_URL;
});
after(() => {
  live.close(); next.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { liveHits = []; nextHits = []; process.env.PURMEMO_SESSIONS_BETA = '1'; });

describe('get_memory_details falls back to the sessions base', () => {
  it('live not-found text → sessions found: returns the session part, same id and auth', async () => {
    liveReply = notFound; nextReply = found;
    const out = await handleGetMemoryDetails({ memoryId: ID });
    assert.equal(liveHits.length, 1); assert.equal(nextHits.length, 1);
    assert.equal(nextHits[0].url, '/api/v10/mcp/tools/execute');
    assert.equal(nextHits[0].auth, 'Bearer user-key');
    assert.equal(nextHits[0].body.tool, 'get_memory_details');
    assert.equal(nextHits[0].body.arguments.memoryId, ID);
    assert.match(out.content.at(-1).text, /SESSION PART/);
  });
  it('live HTTP 404 → sessions found', async () => {
    liveReply = { status: 404, body: { detail: 'Memory not found' } }; nextReply = found;
    const out = await handleGetMemoryDetails({ memoryId: ID });
    assert.equal(nextHits.length, 1);
    assert.match(out.content.at(-1).text, /SESSION PART/);
  });
  it('both not found → the original live not-found', async () => {
    liveReply = notFound; nextReply = notFound;
    const out = await handleGetMemoryDetails({ memoryId: ID });
    assert.equal(nextHits.length, 1);
    assert.match(out.content.at(-1).text, new RegExp(`Memory ${ID} not found`));
  });
  it('live 404 and sessions unreachable/erroring → the original 404 error', async () => {
    liveReply = { status: 404, body: { detail: 'Memory not found' } }; nextReply = { status: 503, body: {} };
    const out = await handleGetMemoryDetails({ memoryId: ID });
    assert.match(out.content.at(-1).text, /Error retrieving memory: Memory not found \(HTTP 404\)/);
  });
  it('beta off → no retry', async () => {
    delete process.env.PURMEMO_SESSIONS_BETA;
    liveReply = notFound; nextReply = found;
    const out = await handleGetMemoryDetails({ memoryId: ID });
    assert.equal(nextHits.length, 0);
    assert.match(out.content.at(-1).text, /not found/);
  });
  it('live found → no retry', async () => {
    liveReply = { status: 200, body: { content: [{ type: 'text', text: 'LIVE MEMORY' }] } }; nextReply = found;
    const out = await handleGetMemoryDetails({ memoryId: ID });
    assert.equal(nextHits.length, 0);
    assert.match(out.content.at(-1).text, /LIVE MEMORY/);
  });
  it('read base on → no sessions retry (reads already go to next)', async () => {
    const { sessionsRetryEnabled } = await import('../dist/tools/sessions.js');
    assert.equal(sessionsRetryEnabled({ PURMEMO_SESSIONS_BETA: '1' }), true);
    assert.equal(sessionsRetryEnabled({ PURMEMO_SESSIONS_BETA: '1', PURMEMO_READ_BASE_URL: 'http://next' }), false);
    assert.equal(sessionsRetryEnabled({}), false);
  });
});
