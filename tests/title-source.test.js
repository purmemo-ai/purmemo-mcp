/**
 * Whose title is it (2026-11-24): save_conversation tells the server whether the title it sends was GIVEN by the
 * caller or GENERATED here from the text. The server owns the rule (a generated title never replaces the title a
 * document already has); this file proves only what the connector sends and what it tells the caller back.
 * Exercises handleSaveConversation via the built dist with the API client mocked, like adr-036-mode-validation.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';

let calls = [];
let reply = { id: 'mem_1', memory_id: 'mem_1', updated: false };
const mockMakeApiCall = mock.fn(async (path, opts) => { calls.push({ path, opts }); return reply; });
mock.module('../dist/lib/api-client.js', {
  namedExports: {
    makeApiCall: mockMakeApiCall,
    sanitizeUnicode: (s) => s,
    safeErrorMessage: (e) => e?.message || 'unknown',
    wafSafeBody: (body) => body,
    getEffectiveApiKey: () => 'test-key',
    makeReadCall: mockMakeApiCall,
  },
});
const { handleSaveConversation, initHandlers } = await import('../dist/tools/handlers.js');
initHandlers({ platform: 'claude-code', getLastRecallIds: () => [], setLastRecallIds: () => {}, readCurrentSessionId: () => 'test-session-id' });

const SMALL = `=== CONVERSATION START ===
USER: This is a small test conversation under the 15K threshold, about the Purmemo save door.
ASSISTANT: Acknowledged. A response that includes the words USER: and ASSISTANT: so the summary check passes, and enough text to be over five hundred characters in total. ${'More words. '.repeat(40)}
=== END ===`;
const LARGE = `=== CONVERSATION START ===\nUSER: A long conversation over 15K characters.\nASSISTANT: ${'x'.repeat(45000)}\n=== END ===`;
const saves = () => calls.filter((c) => c.path === '/api/v1/memories/' && c.opts?.method === 'POST').map((c) => c.opts.body);
const run = async (args, serverReply = { id: 'mem_1', memory_id: 'mem_1', updated: false }) => { calls = []; reply = serverReply; return (await handleSaveConversation(args)).content[0].text; };

describe('save_conversation: the title says whose it is', () => {
  it('a title the caller gave is sent as given', async () => {
    await run({ conversationContent: SMALL, title: 'My real title', conversationId: 'doc-1', mode: 'append' });
    const [body] = saves();
    assert.equal(body.title, 'My real title');
    assert.equal(body.title_source, 'given');
  });

  it('no title: the generated one is sent, marked generated (append and replace)', async () => {
    for (const mode of ['append', 'replace']) {
      await run({ conversationContent: SMALL, conversationId: 'doc-1', mode });
      const [body] = saves();
      assert.ok(body.title && body.title.length > 0, 'a new document still needs a name');
      assert.equal(body.title_source, 'generated', mode);
      assert.equal(body.conversation_id, 'doc-1');
      assert.equal(body.conversation_id_source, 'explicit');
    }
  });

  it('the schema placeholder "Conversation 202…" counts as no title', async () => {
    await run({ conversationContent: SMALL, title: 'Conversation 2026-11-24T10:00:00.000Z', conversationId: 'doc-1', mode: 'append' });
    const [body] = saves();
    assert.equal(body.title_source, 'generated');
    assert.ok(!body.title.startsWith('Conversation 2026-11-24T10'));
  });

  it('a blank title counts as no title', async () => {
    await run({ conversationContent: SMALL, title: '   ', conversationId: 'doc-1', mode: 'append' });
    const [body] = saves();
    assert.equal(body.title_source, 'generated');
    assert.ok(body.title.trim().length > 0);
  });

  it('the id made from a title keeps its meaning: slug of the title, source "title"', async () => {
    await run({ conversationContent: SMALL, title: 'Complete Anime Tracking Database' });
    const [body] = saves();
    assert.equal(body.conversation_id, 'complete-anime-tracking-database');
    assert.equal(body.conversation_id_source, 'title');
    assert.equal(body.title_source, 'given');
  });

  it('a long save in pieces: every part and the index carry the same title source', async () => {
    await run({ conversationContent: LARGE, conversationId: 'doc-long' });
    const bodies = saves();
    assert.ok(bodies.length >= 3, 'parts and an index');
    assert.ok(bodies.every((b) => b.title_source === 'generated'), JSON.stringify(bodies.map((b) => b.title_source)));
    await run({ conversationContent: LARGE, conversationId: 'doc-long', title: 'Long and named' });
    assert.ok(saves().every((b) => b.title_source === 'given'));
    assert.ok(saves().some((b) => b.title === 'Long and named - Index'));
  });

  it('the reply shows the title the document has, and says when it was kept', async () => {
    const kept = await run({ conversationContent: SMALL, conversationId: 'doc-1', mode: 'append' }, { id: 'mem_1', updated: true, title: 'The ledger', title_kept: true });
    assert.match(kept, /📌 Title: The ledger \(kept: pass a title to rename\)/);
    const renamed = await run({ conversationContent: SMALL, conversationId: 'doc-1', mode: 'append', title: 'New name' }, { id: 'mem_1', updated: true, title: 'New name' });
    assert.match(renamed, /📌 Title: New name\n/);
    assert.doesNotMatch(renamed, /kept: pass a title/);
  });

  it('an older server that says nothing about the title: the reply is as before', async () => {
    const text = await run({ conversationContent: SMALL, conversationId: 'doc-1', mode: 'append' }, { id: 'mem_1', updated: true });
    assert.doesNotMatch(text, /📌 Title/);
    assert.match(text, /APPENDED to EXISTING MEMORY/);
  });
});
