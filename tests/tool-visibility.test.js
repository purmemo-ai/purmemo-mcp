/**
 * Tool visibility (2026-10-18): everyone sees a small core; env flags add the
 * sessions beta, the admin tools, or every paused tool. A paused tool called
 * while hidden answers with what to use instead.
 *
 * The list tests run the BUILT server over stdio (the real TOOLS array and the
 * real ListTools / CallTool handlers), with a throwaway HOME and a fake key so
 * nothing touches a real account.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOLS, ADMIN_TOOLS, LEGACY_TOOLS, pausedToolMessage, hiddenToolResult } from '../dist/lib/tool-visibility.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

/** Start the server with extra env, send JSON-RPC requests in order, return the responses by id. */
function rpc(extraEnv, requests) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'purmemo-vis-'));
    const env = { PATH: process.env.PATH, HOME: home, PURMEMO_API_KEY: 'test-key-not-real', PURMEMO_API_URL: 'http://127.0.0.1:9', NODE_ENV: 'production', ...extraEnv };
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const want = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));
    const got = {};
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; got ${Object.keys(got)}`)); }, 15000);
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
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
    want.add(0);
    child.stdin.write(JSON.stringify(init) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n');
  });
}

const listNames = async (env) => (await rpc(env, [{ id: 1, method: 'tools/list' }]))[1].result.tools.map((t) => t.name);

describe('tools/list by env flag (built server over stdio)', () => {
  it('default lists exactly the five core tools', async () => {
    assert.deepEqual((await listNames({})).sort(), [...CORE_TOOLS].sort());
  });
  it('PURMEMO_SESSIONS_BETA=1 adds search_past_sessions and points recall_memories at it', async () => {
    const res = await rpc({ PURMEMO_SESSIONS_BETA: '1' }, [{ id: 1, method: 'tools/list' }]);
    const tools = res[1].result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CORE_TOOLS, 'search_past_sessions'].sort());
    const recall = tools.find((t) => t.name === 'recall_memories');
    assert.match(recall.description, /use search_past_sessions\.$/);
    const sps = tools.find((t) => t.name === 'search_past_sessions');
    assert.equal(sps.annotations.readOnlyHint, true);
    assert.deepEqual(sps.inputSchema.required, ['query']);
  });
  it('without the beta, recall_memories does not mention search_past_sessions', async () => {
    const res = await rpc({}, [{ id: 1, method: 'tools/list' }]);
    assert.doesNotMatch(res[1].result.tools.find((t) => t.name === 'recall_memories').description, /search_past_sessions/);
  });
  it('PURMEMO_ADMIN=1 adds the three admin tools', async () => {
    assert.deepEqual((await listNames({ PURMEMO_ADMIN: '1' })).sort(), [...CORE_TOOLS, ...ADMIN_TOOLS].sort());
  });
  it('PURMEMO_LEGACY_TOOLS=1 restores every paused tool; with admin too, the full prior list of 29', async () => {
    assert.deepEqual((await listNames({ PURMEMO_LEGACY_TOOLS: '1' })).sort(), [...CORE_TOOLS, ...LEGACY_TOOLS].sort());
    const all = await listNames({ PURMEMO_LEGACY_TOOLS: '1', PURMEMO_ADMIN: '1' });
    assert.equal(all.length, 29);
    assert.deepEqual(all.sort(), [...CORE_TOOLS, ...ADMIN_TOOLS, ...LEGACY_TOOLS].sort());
  });
  it('a hidden paused tool called anyway returns the redirect, without touching the network', async () => {
    const res = await rpc({}, [
      { id: 1, method: 'tools/call', params: { name: 'save_artifact', arguments: {} } },
      { id: 2, method: 'tools/call', params: { name: 'run_workflow', arguments: { input: 'x' } } },
      { id: 3, method: 'tools/call', params: { name: 'get_acknowledged_errors', arguments: {} } },
    ]);
    assert.match(res[1].result.content[0].text, /save_artifact is paused\. Use save_conversation instead/);
    assert.equal(res[1].result.isError, true);
    assert.match(res[2].result.content[0].text, /run_workflow is paused; set PURMEMO_LEGACY_TOOLS=1/);
    assert.match(res[3].result.content[0].text, /Admin access required/);
  });
});

describe('redirect messages', () => {
  it('names what to use instead', () => {
    assert.match(pausedToolMessage('commit', {}), /Use save_conversation instead/);
    assert.match(pausedToolMessage('discover_related_conversations', {}), /Use recall_memories instead/);
    assert.match(pausedToolMessage('list_clusters', {}), /Use recall_memories instead/);
    for (const t of ['snapshot', 'snapshot_sources', 'save_snapshot', 'get_snapshot', 'accept_snapshot']) assert.match(pausedToolMessage(t, {}), /recall_memories instead \(it returns summary pages\)/);
    assert.match(pausedToolMessage('share_memory', {}), /paused; set PURMEMO_LEGACY_TOOLS=1/);
  });
  it('runs normally when the group is on, and never blocks core or beta tools', () => {
    assert.equal(hiddenToolResult('save_artifact', { PURMEMO_LEGACY_TOOLS: '1' }), null);
    assert.equal(hiddenToolResult('get_investigations', { PURMEMO_ADMIN: '1' }), null);
    for (const t of [...CORE_TOOLS, 'search_past_sessions']) assert.equal(hiddenToolResult(t, {}), null);
  });
});
