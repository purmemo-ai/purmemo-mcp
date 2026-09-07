/**
 * PURMEMO_SHADOW_SAVE_DISABLED — retiring the client-side SAVE mirror.
 *
 * 2026-09-07 (purmemo-next plan step E): the save mirror moved server-side
 * into purmemo-api, which sees every capture surface with the authenticated
 * user. To avoid mirroring each MCP save twice, the operator sets
 * PURMEMO_SHADOW_SAVE_DISABLED=1 and fireShadowDoor no-ops. Everything else
 * — the live save itself, and the RECALL mirror (fireShadowRecall) which
 * shares the same URL/token — must be unaffected.
 *
 * Exercised against the built dist with makeApiCall and global.fetch mocked,
 * same harness shape as shadow-door-source-key.test.js.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';

let apiCalls = [];
let idSeq = 0;
const mockMakeApiCall = mock.fn(async (path, opts) => {
  idSeq += 1;
  const id = `mem_${idSeq}`;
  apiCalls.push({ path, opts, id });
  return { id, memory_id: id, updated: false };
});
const memoryPosts = () => apiCalls.filter((c) => c.path === '/api/v1/memories/');

mock.module('../dist/lib/api-client.js', {
  namedExports: {
    makeApiCall: mockMakeApiCall,
    sanitizeUnicode: (s) => s,
    safeErrorMessage: (e) => e?.message || 'unknown',
    wafSafeBody: (body) => body,
  },
});

const { handleSaveConversation, initHandlers } = await import('../dist/tools/handlers.js');

initHandlers({
  platform: 'claude-code',
  getLastRecallIds: () => [],
  setLastRecallIds: () => {},
  readCurrentSessionId: () => 'test-session-id',
});

let shadowPosts = [];
const realFetch = globalThis.fetch;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const SMALL_CONTENT = `=== CONVERSATION START ===
USER: This is a small test conversation under the 15K threshold.
ASSISTANT: Acknowledged. Returning a response that includes the words USER: and ASSISTANT: so the summary-detection check passes. We need at least 500 chars total to bypass the summary warning. Adding more padding here so the test content is realistic and crosses the minimum threshold. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
=== END ===`;

function reset() {
  apiCalls = [];
  shadowPosts = [];
}

before(() => {
  process.env.PURMEMO_SHADOW_DOOR_URL = 'http://127.0.0.1:59999/shadow/save';
  process.env.PURMEMO_SHADOW_DOOR_TOKEN = 'test-token';
  process.env.PURMEMO_SHADOW_USER_ID = '982d25cd-592c-4fd7-90a0-7435a10244d3';
  globalThis.fetch = async (url, opts) => {
    shadowPosts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.PURMEMO_SHADOW_DOOR_URL;
  delete process.env.PURMEMO_SHADOW_DOOR_TOKEN;
  delete process.env.PURMEMO_SHADOW_SAVE_DISABLED;
});

describe('shadow door: PURMEMO_SHADOW_SAVE_DISABLED', () => {
  it('baseline: with the flag unset a save is mirrored once', async () => {
    reset();
    delete process.env.PURMEMO_SHADOW_SAVE_DISABLED;
    await handleSaveConversation({ title: 'baseline', conversationContent: SMALL_CONTENT });
    await settle();
    assert.strictEqual(memoryPosts().length, 1, 'the live save still happens');
    const saves = shadowPosts.filter((p) => p.body && p.body.source === 'mcp-shadow');
    assert.strictEqual(saves.length, 1, 'exactly one shadow save post');
    assert.strictEqual(saves[0].body.user_id, '982d25cd-592c-4fd7-90a0-7435a10244d3');
  });

  it('flag=1: the live save still happens, the shadow save post does NOT', async () => {
    reset();
    process.env.PURMEMO_SHADOW_SAVE_DISABLED = '1';
    await handleSaveConversation({ title: 'retired', conversationContent: SMALL_CONTENT });
    await settle();
    assert.strictEqual(memoryPosts().length, 1, 'the live save is unaffected');
    const saves = shadowPosts.filter((p) => p.body && p.body.source === 'mcp-shadow');
    assert.strictEqual(saves.length, 0, 'no client-side shadow save when retired');
  });

  it('only the exact value "1" retires it (no accidental "true"/"yes")', async () => {
    reset();
    process.env.PURMEMO_SHADOW_SAVE_DISABLED = 'true';
    await handleSaveConversation({ title: 'not-retired', conversationContent: SMALL_CONTENT });
    await settle();
    const saves = shadowPosts.filter((p) => p.body && p.body.source === 'mcp-shadow');
    assert.strictEqual(saves.length, 1, 'a non-"1" value does not retire the mirror');
    delete process.env.PURMEMO_SHADOW_SAVE_DISABLED;
  });
});
