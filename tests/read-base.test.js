/**
 * Read-base routing (purmemo-next stage 1, 2026-09-16): the three read tools go
 * to next when PURMEMO_READ_BASE_URL is set; anything else, any failure, any
 * kill switch → live. Exercised against the built dist with injected deps.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createReadCall, readBaseEligible, readBaseUrl } from '../dist/lib/api-client.js';

const body = (tool, args = {}) => JSON.stringify({ tool, arguments: args });
const okFetch = (payload, status = 200) => async () => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
const env = { PURMEMO_READ_BASE_URL: 'http://next:3211/' };
const noKill = () => false;

describe('readBaseUrl / readBaseEligible', () => {
  it('off unless the env is set; kill file and DISABLED=1 win instantly', () => {
    assert.equal(readBaseUrl({}, noKill), null);
    assert.equal(readBaseUrl(env, noKill), 'http://next:3211');
    assert.equal(readBaseUrl({ ...env, PURMEMO_READ_BASE_DISABLED: '1' }, noKill), null);
    assert.equal(readBaseUrl(env, () => true), null);
  });
  it('only the three read tools, and never with live-only filters', () => {
    assert.equal(readBaseEligible({ tool: 'recall_memories', arguments: { query: 'x' } }), true);
    assert.equal(readBaseEligible({ tool: 'get_memory_details', arguments: {} }), true);
    assert.equal(readBaseEligible({ tool: 'discover_related_conversations', arguments: {} }), true);
    assert.equal(readBaseEligible({ tool: 'save_conversation', arguments: {} }), false);
    assert.equal(readBaseEligible({ tool: 'list_clusters', arguments: {} }), false);
    assert.equal(readBaseEligible({ tool: 'recall_memories', arguments: { query: 'x', cluster: 'Cosmo' } }), false);
    assert.equal(readBaseEligible({ tool: 'recall_memories', arguments: { query: 'x', intent: 'decision' } }), false);
  });
});

describe('createReadCall', () => {
  it('serves an eligible read from next and reports served_by=next', async () => {
    const events = []; const fallback = async () => { throw new Error('should not fall back'); };
    const call = createReadCall({ fetchImpl: okFetch({ content: [{ type: 'text', text: 'from next' }] }), fallback, env, killFileExists: noKill, key: 'k', onEvent: (e) => events.push(e) });
    const data = await call('/api/v10/mcp/tools/execute', { method: 'POST', body: body('recall_memories', { query: 'q' }) });
    assert.equal(data.content[0].text, 'from next'); assert.equal(events[0].served_by, 'next');
  });
  it('falls back to live on 501, on 5xx, on network error, and when next returns non-JSON', async () => {
    for (const fetchImpl of [okFetch({ error: 'not_supported_on_next' }, 501), okFetch({}, 503), async () => { throw new Error('ECONNREFUSED'); }, async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => '' })]) {
      const events = []; const fallback = async () => ({ content: [{ type: 'text', text: 'from live' }] });
      const call = createReadCall({ fetchImpl, fallback, env, killFileExists: noKill, key: 'k', onEvent: (e) => events.push(e) });
      const data = await call('/api/v10/mcp/tools/execute', { method: 'POST', body: body('recall_memories', { query: 'q' }) });
      assert.equal(data.content[0].text, 'from live'); assert.equal(events[0].served_by, 'live');
    }
  });
  it('goes straight to live for non-read tools, with the kill file, or without a key — and never touches next', async () => {
    let touched = 0; const fetchImpl = async () => { touched++; return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
    const fallback = async () => 'live';
    assert.equal(await createReadCall({ fetchImpl, fallback, env, killFileExists: noKill, key: 'k' })('/api/v10/mcp/tools/execute', { body: body('save_conversation') }), 'live');
    assert.equal(await createReadCall({ fetchImpl, fallback, env, killFileExists: () => true, key: 'k' })('/api/v10/mcp/tools/execute', { body: body('recall_memories', { query: 'q' }) }), 'live');
    assert.equal(await createReadCall({ fetchImpl, fallback, env, killFileExists: noKill, key: null })('/api/v10/mcp/tools/execute', { body: body('recall_memories', { query: 'q' }) }), 'live');
    assert.equal(touched, 0);
  });
});
