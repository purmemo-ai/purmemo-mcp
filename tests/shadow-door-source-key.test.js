/**
 * Shadow door source_key tests
 *
 * The shadow door mirrors a successful cloud save into the rebuilt purmemo
 * engine. It must now carry a stable per-memory identity (source_key) so the
 * rebuild's drift instrument can see supersession (same memory, new content).
 *
 * What these tests lock down:
 *   1. Single saves send source_key = the live memory id.
 *   2. An update to the SAME memory sends the SAME source_key (stability).
 *   3. Chunked saves send exactly ONE shadow request carrying the PARENT
 *      (index) memory id — never a part id. One memory, never N sources.
 *   4. THROW INJECTION: with source_key derivation forced to throw, the live
 *      save still succeeds and still returns the normal tool result. This is
 *      the non-interference invariant, proven rather than asserted.
 *
 * Exercised against the built dist with makeApiCall and global.fetch mocked.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';

// ---- mock the cloud API ------------------------------------------------
// Each POST to /api/v1/memories/ gets a distinct id so we can prove which id
// the shadow door picked (part ids vs the index id).
let apiCallCount = 0;
let apiCalls = [];
// When set, every save returns this pinned id (mimics the backend's upsert
// returning the same memory row on re-save). Null = distinct id per call.
let pinnedMemoryId = null;
let idSeq = 0;
const mockMakeApiCall = mock.fn(async (path, opts) => {
  apiCallCount += 1;
  idSeq += 1;
  const id = pinnedMemoryId || `mem_${idSeq}`;
  apiCalls.push({ path, opts, id });
  return { id, memory_id: id, updated: false };
});

// Only the memory-creating POSTs matter for source_key. Other calls the
// handler makes (background/intelligence lookups) are filtered out, and
// stragglers from a previous test can never confuse the assertions.
const memoryPosts = () => apiCalls.filter((c) => c.path === '/api/v1/memories/');

// Repo convention (see adr-036 test): reset shared state explicitly at the top
// of each test rather than relying on hook ordering.
function reset() {
  apiCallCount = 0;
  apiCalls = [];
  shadowPosts = [];
  pinnedMemoryId = null;
  __setDeriveSourceKeyForTest(null);
}

mock.module('../dist/lib/api-client.js', {
  namedExports: {
    makeApiCall: mockMakeApiCall,
    sanitizeUnicode: (s) => s,
    safeErrorMessage: (e) => e?.message || 'unknown',
    wafSafeBody: (body) => body,
  },
});

const { handleSaveConversation, initHandlers, __setDeriveSourceKeyForTest } =
  await import('../dist/tools/handlers.js');

initHandlers({
  platform: 'claude-code',
  getLastRecallIds: () => [],
  setLastRecallIds: () => {},
  readCurrentSessionId: () => 'test-session-id',
});

// ---- mock the shadow door endpoint -------------------------------------
let shadowPosts = [];
const realFetch = globalThis.fetch;

const SMALL_CONTENT = `=== CONVERSATION START ===
USER: This is a small test conversation under the 15K threshold.
ASSISTANT: Acknowledged. Returning a response that includes the words USER: and ASSISTANT: so the summary-detection check passes. We need at least 500 chars total to bypass the summary warning. Adding more padding here so the test content is realistic and crosses the minimum threshold. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
=== END ===`;

const LARGE_CONTENT = `=== CONVERSATION START ===
USER: Here is a long conversation that will exceed 15K chars.
ASSISTANT: ${'x'.repeat(40000)}
=== END ===`;

// The shadow POST is fire-and-forget, so it is dispatched but not awaited by
// the handler. Yield to the microtask queue before asserting on it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

before(() => {
  process.env.PURMEMO_SHADOW_DOOR_URL = 'http://127.0.0.1:59999/shadow';
  process.env.PURMEMO_SHADOW_DOOR_TOKEN = 'test-token';
  process.env.PURMEMO_SHADOW_USER_ID = 'chris';

  globalThis.fetch = async (url, opts) => {
    shadowPosts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.PURMEMO_SHADOW_DOOR_URL;
  delete process.env.PURMEMO_SHADOW_DOOR_TOKEN;
  __setDeriveSourceKeyForTest(null);
});

describe('shadow door: source_key', () => {

  it('single save sends source_key = the live memory id', async () => {
    reset();
    const result = await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Shadow Source Key - Single',
    });
    await settle();

    assert.match(result.content[0].text, /CONVERSATION SAVED/, 'live save must succeed');
    const posts = memoryPosts();
    assert.equal(posts.length, 1, 'exactly one memory POST');
    assert.equal(shadowPosts.length, 1, 'exactly one shadow POST');
    assert.equal(shadowPosts[0].body.source_key, posts[0].id,
      'source_key is the live memory id returned by the cloud save');
    assert.equal(shadowPosts[0].body.source, 'mcp-shadow');
    assert.ok(shadowPosts[0].body.content.length > 0, 'content still mirrored');
  });

  it('re-save of the same memory sends the SAME source_key', async () => {
    reset();
    // Pin the cloud API to one stable id, as the real upsert does.
    pinnedMemoryId = 'mem_stable';
    await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Shadow Source Key - Stable',
      conversationId: 'shadow-stable',
    });
    await settle();

    await handleSaveConversation({
      conversationContent: `${SMALL_CONTENT}\nUSER: one more turn.`,
      title: 'Shadow Source Key - Stable',
      conversationId: 'shadow-stable',
    });
    await settle();

    assert.equal(shadowPosts.length, 2, 'both saves mirrored');
    assert.equal(shadowPosts[0].body.source_key, 'mem_stable');
    assert.equal(shadowPosts[1].body.source_key, 'mem_stable',
      'update must reuse the same source_key, not mint a new one');
  });

  it('chunked save sends ONE shadow POST carrying the PARENT index id', async () => {
    reset();
    const result = await handleSaveConversation({
      conversationContent: LARGE_CONTENT,
      title: 'Shadow Source Key - Chunked',
    });
    await settle();

    assert.match(result.content[0].text, /Auto-chunked/, 'live chunked save must succeed');
    const posts = memoryPosts();
    assert.ok(posts.length >= 3, 'multiple part memories plus an index were created');

    assert.equal(shadowPosts.length, 1,
      'one memory must never appear as N sources — exactly one shadow POST');

    // The index memory is the LAST memory POST the chunked path makes.
    const indexId = posts[posts.length - 1].id;
    const partIds = posts.slice(0, -1).map((c) => c.id);

    assert.equal(shadowPosts[0].body.source_key, indexId,
      'source_key must be the parent (index) memory id');
    assert.ok(!partIds.includes(shadowPosts[0].body.source_key),
      'source_key must never be a per-chunk part id');
  });

  it('THROW INJECTION: derivation throwing cannot break the live save', async () => {
    reset();
    let threw = 0;
    __setDeriveSourceKeyForTest(() => {
      threw += 1;
      throw new Error('injected source_key derivation failure');
    });

    const result = await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Shadow Source Key - Throw Injection',
    });
    await settle();

    assert.equal(threw, 1, 'the injected derivation actually ran and threw');
    // The live save path is completely unaffected.
    assert.ok(result && result.content && result.content[0], 'handler returned a normal result');
    assert.match(result.content[0].text, /CONVERSATION SAVED/,
      'live save still succeeds despite the derivation throwing');
    assert.equal(memoryPosts().length, 1, 'the real cloud save still happened exactly once');
    // And the door degrades to silence rather than sending a keyless row.
    assert.equal(shadowPosts.length, 0, 'no keyless shadow row is sent');
  });

  it('THROW INJECTION on the chunked branch cannot break the live save', async () => {
    reset();
    __setDeriveSourceKeyForTest(() => {
      throw new Error('injected source_key derivation failure (chunked)');
    });

    const result = await handleSaveConversation({
      conversationContent: LARGE_CONTENT,
      title: 'Shadow Source Key - Throw Injection Chunked',
    });
    await settle();

    assert.match(result.content[0].text, /Auto-chunked/,
      'live chunked save still succeeds despite the derivation throwing');
    assert.equal(shadowPosts.length, 0, 'no keyless shadow row is sent');
  });

  it('door stays a total no-op when the env flags are unset', async () => {
    reset();
    const url = process.env.PURMEMO_SHADOW_DOOR_URL;
    delete process.env.PURMEMO_SHADOW_DOOR_URL;
    try {
      const result = await handleSaveConversation({
        conversationContent: SMALL_CONTENT,
        title: 'Shadow Source Key - Flag Off',
      });
      await settle();
      assert.match(result.content[0].text, /CONVERSATION SAVED/);
      assert.equal(shadowPosts.length, 0, 'no shadow POST when the flag is off');
    } finally {
      process.env.PURMEMO_SHADOW_DOOR_URL = url;
    }
  });
});
