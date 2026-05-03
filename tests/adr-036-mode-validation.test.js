/**
 * ADR-036 mode validation tests
 *
 * Verifies the two latent bugs caught in self-review:
 *   1. Invalid `mode` values are rejected loudly (not silently defaulted)
 *   2. mode='append' on chunked content (>15K) is rejected with clear error
 *
 * These tests exercise handleSaveConversation directly via the built dist,
 * with the API client mocked. They validate the handler-level guards added
 * in commit f8d381c, NOT end-to-end API behavior (that is verified post-deploy).
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert';

// Mock makeApiCall before importing handlers — handlers.js imports from
// '../lib/api-client.js', so we must intercept at the module-resolution layer.
let makeApiCallCalls = [];
const mockMakeApiCall = mock.fn(async (path, opts) => {
  makeApiCallCalls.push({ path, opts });
  // Return a benign success response so we can detect "did the API get called?"
  return { id: 'mem_test_123', memory_id: 'mem_test_123', updated: false };
});

mock.module('../dist/lib/api-client.js', {
  namedExports: {
    makeApiCall: mockMakeApiCall,
    sanitizeUnicode: (s) => s,
    safeErrorMessage: (e) => e?.message || 'unknown',
    wafSafeBody: (body) => body,
  },
});

// Now import handlers — they will pick up our mock
const { handleSaveConversation, initHandlers } = await import('../dist/tools/handlers.js');

initHandlers({
  platform: 'claude-code',
  getLastRecallIds: () => [],
  setLastRecallIds: () => {},
  readCurrentSessionId: () => 'test-session-id',
});

const SMALL_CONTENT = `=== CONVERSATION START ===
USER: This is a small test conversation under the 15K threshold.
ASSISTANT: Acknowledged. Returning a response that includes the words USER: and ASSISTANT: so the summary-detection check passes. We need at least 500 chars total to bypass the summary warning. Adding more padding here so the test content is realistic and crosses the minimum threshold. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
=== END ===`;

const LARGE_CONTENT = `=== CONVERSATION START ===
USER: Here is a long conversation that will exceed 15K chars.
ASSISTANT: ${'x'.repeat(16000)}
=== END ===`;

describe('ADR-036: mode parameter validation', () => {

  it('rejects invalid mode values with explicit error message', async () => {
    makeApiCallCalls = [];
    const result = await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Test - Invalid Mode',
      mode: 'apend', // typo
    });

    const text = result.content[0].text;
    assert.match(text, /Invalid mode/, 'Should return validation error');
    assert.match(text, /apend/, 'Should echo the bad value');
    assert.match(text, /replace.*append/, 'Should list valid options');
    assert.equal(makeApiCallCalls.length, 0, 'Should NOT call the API');
  });

  it('rejects another invalid mode (merge) loudly', async () => {
    makeApiCallCalls = [];
    const result = await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Test - Merge Mode',
      mode: 'merge',
    });

    const text = result.content[0].text;
    assert.match(text, /Invalid mode/);
    assert.equal(makeApiCallCalls.length, 0);
  });

  it('accepts mode="append" for small content (<15K)', async () => {
    makeApiCallCalls = [];
    await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Test - Append Small',
      mode: 'append',
    });

    // Should hit the single-content path which posts to /api/v1/memories/
    const memoryPosts = makeApiCallCalls.filter(c => c.path === '/api/v1/memories/');
    assert.ok(memoryPosts.length >= 1, 'Should call the memories endpoint');

    const postBody = memoryPosts[0].opts.body;
    assert.equal(postBody.mode, 'append', 'Should forward mode=append to API');
  });

  it('accepts mode="replace" for small content (<15K)', async () => {
    makeApiCallCalls = [];
    await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Test - Replace Small',
      mode: 'replace',
    });

    const memoryPosts = makeApiCallCalls.filter(c => c.path === '/api/v1/memories/');
    const postBody = memoryPosts[0].opts.body;
    assert.equal(postBody.mode, 'replace');
  });

  it('defaults to replace when mode is not specified', async () => {
    makeApiCallCalls = [];
    await handleSaveConversation({
      conversationContent: SMALL_CONTENT,
      title: 'Test - No Mode',
    });

    const memoryPosts = makeApiCallCalls.filter(c => c.path === '/api/v1/memories/');
    const postBody = memoryPosts[0].opts.body;
    assert.equal(postBody.mode, 'replace', 'Default should be replace');
  });
});

describe('ADR-036: append + chunking guard', () => {

  it('rejects mode="append" for content >15K with clear error message', async () => {
    makeApiCallCalls = [];
    const result = await handleSaveConversation({
      conversationContent: LARGE_CONTENT,
      title: 'Test - Append Large',
      mode: 'append',
    });

    const text = result.content[0].text;
    assert.match(text, /APPEND MODE NOT SUPPORTED FOR CHUNKED SAVES/, 'Should return chunked-append error');
    assert.match(text, /15,000/, 'Should mention the threshold');
    assert.match(text, /smaller delta|mode='replace'/, 'Should suggest alternatives');
    assert.match(text, /ADR-038/, 'Should reference the future ADR');

    // Critically: NO chunk POSTs should have happened
    const memoryPosts = makeApiCallCalls.filter(c => c.path === '/api/v1/memories/');
    assert.equal(memoryPosts.length, 0, 'Should NOT call the API for any chunk');
  });

  it('allows mode="replace" for content >15K (chunked path proceeds)', async () => {
    makeApiCallCalls = [];
    await handleSaveConversation({
      conversationContent: LARGE_CONTENT,
      title: 'Test - Replace Large',
      mode: 'replace',
    });

    // Should hit the chunked path: N parts + 1 index = at least 2 posts
    const memoryPosts = makeApiCallCalls.filter(c => c.path === '/api/v1/memories/');
    assert.ok(memoryPosts.length >= 2, 'Should call API for parts + index');

    // Each part should have mode='replace'; index always replace
    for (const post of memoryPosts) {
      assert.equal(post.opts.body.mode, 'replace');
    }
  });

  it('allows mode unset (defaults replace) for content >15K', async () => {
    makeApiCallCalls = [];
    await handleSaveConversation({
      conversationContent: LARGE_CONTENT,
      title: 'Test - Default Large',
    });

    const memoryPosts = makeApiCallCalls.filter(c => c.path === '/api/v1/memories/');
    assert.ok(memoryPosts.length >= 2);
    for (const post of memoryPosts) {
      assert.equal(post.opts.body.mode, 'replace');
    }
  });
});
