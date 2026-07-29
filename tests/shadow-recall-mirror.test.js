/**
 * Shadow recall mirror tests
 *
 * The read-side twin of the shadow door: every recall_memories query is
 * mirrored fire-and-forget to the rebuilt engine's /recall endpoint so the
 * rebuild's recall_log accumulates real usage signal.
 *
 * What these tests lock down:
 *   1. A recall fires exactly ONE shadow POST to <door-base>/recall carrying
 *      {query, limit}, and the live recall result is returned unchanged.
 *   2. With the shadow env absent, ZERO shadow requests fire (exact prior
 *      behavior).
 *   3. THROW INJECTION: a shadow endpoint that rejects outright does not
 *      affect the live recall result — the non-interference invariant.
 *
 * Exercised against the built dist with makeApiCall and global.fetch mocked
 * (same harness pattern as shadow-door-source-key.test.js).
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';

// ---- mock the cloud API ------------------------------------------------
const mockMakeApiCall = mock.fn(async () => ({
  content: [{ type: 'text', text: 'LIVE RECALL RESULT' }],
}));

mock.module('../dist/lib/api-client.js', {
  namedExports: {
    makeApiCall: mockMakeApiCall,
    sanitizeUnicode: (s) => s,
    safeErrorMessage: (e) => e?.message || 'unknown',
    wafSafeBody: (body) => body,
  },
});

const { handleRecallMemories, initHandlers } = await import('../dist/tools/handlers.js');

initHandlers({
  platform: 'claude-code',
  getLastRecallIds: () => [],
  setLastRecallIds: () => {},
  readCurrentSessionId: () => 'test-session-id',
});

// ---- mock fetch ---------------------------------------------------------
// The handler's recall path also fetches the local AMP (localhost:7832), so
// assertions filter to the shadow /recall URL only.
let fetchCalls = [];
let shadowShouldReject = false;
const realFetch = globalThis.fetch;
const shadowRecalls = () => fetchCalls.filter((c) => String(c.url).endsWith('/recall'));

// Fire-and-forget: yield before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function reset() {
  fetchCalls = [];
  shadowShouldReject = false;
  process.env.PURMEMO_SHADOW_DOOR_URL = 'http://127.0.0.1:59999/door/save';
  process.env.PURMEMO_SHADOW_DOOR_TOKEN = 'test-token';
}

before(() => {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (String(url).endsWith('/recall') && shadowShouldReject) {
      throw new Error('shadow endpoint down');
    }
    // Local AMP probe gets a "not running" style miss; shadow gets a 200.
    if (String(url).includes('localhost:7832')) return { ok: false, status: 503 };
    return { ok: true, status: 200 };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.PURMEMO_SHADOW_DOOR_URL;
  delete process.env.PURMEMO_SHADOW_DOOR_TOKEN;
});

describe('shadow recall mirror', () => {

  it('mirrors the query to <door-base>/recall and returns the live result', async () => {
    reset();
    const result = await handleRecallMemories({ query: 'what did we decide about ci', limit: '7' });
    await settle();

    assert.equal(result.content[0].text, 'LIVE RECALL RESULT', 'live result unchanged');
    const posts = shadowRecalls();
    assert.equal(posts.length, 1, 'exactly one shadow recall POST');
    assert.equal(posts[0].url, 'http://127.0.0.1:59999/door/recall', '/save sibling route');
    assert.equal(posts[0].body.query, 'what did we decide about ci');
    assert.equal(posts[0].body.limit, 7);
  });

  it('fires nothing when the shadow env is absent', async () => {
    reset();
    delete process.env.PURMEMO_SHADOW_DOOR_URL;
    delete process.env.PURMEMO_SHADOW_DOOR_TOKEN;
    const result = await handleRecallMemories({ query: 'anything', limit: '5' });
    await settle();

    assert.equal(result.content[0].text, 'LIVE RECALL RESULT');
    assert.equal(shadowRecalls().length, 0, 'no shadow request without env');
  });

  it('a rejecting shadow endpoint never affects the live recall', async () => {
    reset();
    shadowShouldReject = true;
    const result = await handleRecallMemories({ query: 'resilience check', limit: '3' });
    await settle();

    assert.equal(result.content[0].text, 'LIVE RECALL RESULT', 'live result survives shadow failure');
    assert.equal(shadowRecalls().length, 1, 'shadow was attempted');
  });
});
