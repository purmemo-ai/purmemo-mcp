/**
 * The one input check for every tool call (lib/tool-input.ts), 2026-11-03.
 * Unit tests on the check itself, then contract tests over the BUILT server's full tool list
 * (every tool, including paused ones) so a new tool can't break the naming rule unnoticed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToolInput, ALIASES } from '../dist/lib/tool-input.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

const DETAILS = { name: 'get_memory_details', inputSchema: { type: 'object', properties: { memoryId: { type: 'string' }, offset: { type: 'number' } }, required: ['memoryId'] } };
const SAVE = { name: 'save_conversation', inputSchema: { type: 'object', properties: { conversationContent: { type: 'string' }, title: { type: 'string' } }, required: ['conversationContent'] } };
const SHARE = { name: 'share_memory', inputSchema: { type: 'object', properties: { memory_id: { type: 'string' }, visibility: { type: 'string' } }, required: ['memory_id', 'visibility'] } };
const TOOLS = [DETAILS, SAVE, SHARE];
const UUID = 'd5463fbc-99c1-4b8a-b6a1-07f712015bdc';

describe('checkToolInput', () => {
  it('maps memory_id to memoryId (the 2026-11-03 read-back failure)', () => {
    const r = checkToolInput('get_memory_details', { memory_id: UUID }, TOOLS);
    assert.equal(r.error, undefined);
    assert.equal(r.args.memoryId, UUID);
    assert.equal('memory_id' in r.args, false);
    assert.deepEqual(r.mapped, ['memory_id→memoryId']);
  });

  it('maps content to conversationContent (the 0-character save)', () => {
    const r = checkToolInput('save_conversation', { content: 'x'.repeat(600), title: 't' }, TOOLS);
    assert.equal(r.error, undefined);
    assert.equal(r.args.conversationContent.length, 600);
  });

  it('maps the other way for tools that publish memory_id', () => {
    const r = checkToolInput('share_memory', { memoryId: UUID, visibility: 'public' }, TOOLS);
    assert.equal(r.error, undefined);
    assert.equal(r.args.memory_id, UUID);
  });

  it('never overwrites a published name the caller did send', () => {
    const r = checkToolInput('get_memory_details', { memoryId: UUID, id: 'other' }, TOOLS);
    assert.equal(r.args.memoryId, UUID);
    assert.deepEqual(r.mapped, []);
  });

  it('a missing required input names the near-miss the caller sent', () => {
    const r = checkToolInput('get_memory_details', { memroyId: UUID }, TOOLS);
    assert.ok(r.error);
    assert.match(r.error.content[0].text, /memoryId is missing — you sent "memroyId"; did you mean "memoryId"\?/);
    assert.equal(r.error.isError, true);
  });

  it('a missing required input with no near-miss says plainly what is needed', () => {
    const r = checkToolInput('get_memory_details', {}, TOOLS);
    assert.match(r.error.content[0].text, /memoryId is missing \(string\)/);
    assert.doesNotMatch(r.error.content[0].text, /undefined/);
  });

  it('an empty string counts as missing', () => {
    assert.ok(checkToolInput('get_memory_details', { memoryId: '  ' }, TOOLS).error);
  });

  it('unknown extra inputs are reported, not rejected', () => {
    const r = checkToolInput('get_memory_details', { memoryId: UUID, verbose: true }, TOOLS);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.unknown, ['verbose']);
  });

  it('the account wrapper input is always allowed', () => {
    assert.deepEqual(checkToolInput('get_memory_details', { memoryId: UUID, account: 'a@b.c' }, TOOLS).unknown, []);
  });

  it('unknown tools and non-object arguments pass through safely', () => {
    assert.deepEqual(checkToolInput('no_such_tool', { a: 1 }, TOOLS).args, { a: 1 });
    assert.equal(checkToolInput('get_memory_details', null, TOOLS).error.isError, true);
  });
});

/** Start the built server with extra env, send JSON-RPC requests, return the responses by id. */
function rpc(extraEnv, requests) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'purmemo-input-'));
    const env = { PATH: process.env.PATH, HOME: home, PURMEMO_API_KEY: 'test-key-not-real', PURMEMO_API_URL: 'http://127.0.0.1:9', NODE_ENV: 'production', ...extraEnv };
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const want = new Set([0, ...requests.map((r) => r.id)]);
    const got = {};
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; got ${Object.keys(got)}`)); }, 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && want.has(msg.id)) {
          got[msg.id] = msg;
          if (Object.keys(got).length === want.size) { clearTimeout(timer); child.kill(); resolve(got); }
        }
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n');
  });
}

const ALL_ON = { PURMEMO_LEGACY_TOOLS: '1', PURMEMO_ADMIN: '1', PURMEMO_SESSIONS_BETA: '1' };
const squash = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

describe('every tool honours the input contract (built server, all tools listed)', () => {
  it('each tool publishes an object schema whose required inputs are all declared', async () => {
    const tools = (await rpc(ALL_ON, [{ id: 1, method: 'tools/list' }]))[1].result.tools;
    assert.ok(tools.length >= 25, `expected the full list, got ${tools.length}`);
    for (const t of tools) {
      assert.equal(t.inputSchema?.type, 'object', `${t.name}: inputSchema.type`);
      assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === 'object', `${t.name}: properties`);
      for (const r of t.inputSchema.required || []) assert.ok(r in t.inputSchema.properties, `${t.name}: required "${r}" is not declared`);
    }
  });

  it('one input is never spelled two ways across tools unless ALIASES covers it', async () => {
    const tools = (await rpc(ALL_ON, [{ id: 1, method: 'tools/list' }]))[1].result.tools;
    const spellings = new Map();
    for (const t of tools) for (const p of Object.keys(t.inputSchema.properties)) {
      const k = squash(p);
      if (!spellings.has(k)) spellings.set(k, new Set());
      spellings.get(k).add(p);
    }
    for (const set of spellings.values()) {
      if (set.size < 2) continue;
      for (const a of set) for (const b of set) {
        if (a !== b) assert.ok((ALIASES[a] || []).includes(b), `inputs "${a}" and "${b}" mean the same thing: add them to ALIASES in src/lib/tool-input.ts`);
      }
    }
  });

  it('end to end: get_memory_details with memory_id reaches the handler; with nothing, says what it needs', async () => {
    const got = await rpc({}, [
      { id: 1, method: 'tools/call', params: { name: 'get_memory_details', arguments: { memory_id: UUID } } },
      { id: 2, method: 'tools/call', params: { name: 'get_memory_details', arguments: {} } },
    ]);
    const t1 = JSON.stringify(got[1]);
    assert.doesNotMatch(t1, /Invalid memory ID|needs:/, 'memory_id was accepted');
    assert.match(got[2].result.content[0].text, /get_memory_details needs:\n• memoryId is missing/);
  });
});
