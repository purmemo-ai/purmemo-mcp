/**
 * Per-call account selection (2026-10-25): the selector is a choice among accounts signed in on this
 * machine, refused before any network call otherwise; a non-default account runs bound to its own key
 * for that call only; side channels see the scope; transfer_memory validates both ends and refuses
 * multi-part documents. Every test uses a throwaway config dir; nothing touches a real account.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateSelector, multiAccountEnabled, signedInAccounts, runAsAccount, runBoundToAccount,
  isAlternateAccountScope, currentAccountScope, AccountSelectorError, defaultAccount,
} from '../dist/auth/accounts.js';
import { withAccountTools, callOnAccount, handleTransferMemory, transferToolDefinition, ACCOUNT_TOOLS } from '../dist/tools/accounts.js';
import TokenStore from '../dist/auth/token-store.js';
import { profileFile } from '../dist/auth/profile-resolver.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
const A = 'personal@example.com';
const B = 'work@example.org';
const UUID = '11111111-2222-4333-8444-555555555555';

/** A fresh config dir with the given signed-in profiles (real encrypted tokens), A active. */
async function sandbox(emails = [A, B]) {
  const dir = mkdtempSync(join(tmpdir(), 'purmemo-acct-'));
  mkdirSync(join(dir, 'profiles'), { recursive: true });
  process.env.PURMEMO_CONFIG_DIR = dir;
  delete process.env.PURMEMO_PROFILE;
  delete process.env.PURMEMO_REMOTE;
  delete process.env.PURMEMO_MULTI_ACCOUNT;
  for (const e of emails) {
    await new TokenStore(profileFile(e)).saveToken({ access_token: `tok-${e}`, token_type: 'Bearer', user: { email: e } });
  }
  writeFileSync(join(dir, 'active'), emails[0]);
  return dir;
}

/** A runWithApiKey stand-in that records which key each call was bound to. */
function recorder() {
  const keys = [];
  const run = async (key, fn) => { keys.push(key); return fn(); };
  return { keys, run };
}

describe('account selector', () => {
  beforeEach(() => sandbox());

  it('lists the signed-in accounts and the default', () => {
    assert.deepEqual(signedInAccounts(), [A, B].sort());
    assert.equal(defaultAccount(), A);
  });
  it('accepts a signed-in account, case-insensitively', () => {
    assert.equal(validateSelector('WORK@example.org'), B);
  });
  it('refuses an account that is not signed in, and non-strings', () => {
    assert.throws(() => validateSelector('someone@else.com'), AccountSelectorError);
    assert.throws(() => validateSelector(''), AccountSelectorError);
    assert.throws(() => validateSelector({ email: B }), AccountSelectorError);
    assert.throws(() => validateSelector('../profiles/x@y.z'), AccountSelectorError);
  });
  it('is never available in remote (hosted) mode', () => {
    assert.throws(() => validateSelector(B, { PURMEMO_REMOTE: '1' }, []), /only available in the local/);
    assert.equal(multiAccountEnabled({ PURMEMO_REMOTE: '1' }, []), false);
  });
  it('is offered only with two or more accounts, and can be switched off', async () => {
    assert.equal(multiAccountEnabled({}, []), true);
    assert.equal(multiAccountEnabled({ PURMEMO_MULTI_ACCOUNT: '0' }, []), false);
    await sandbox([A]);
    assert.equal(multiAccountEnabled({}, []), false);
  });
});

describe('running a call on an account', () => {
  beforeEach(() => sandbox());

  it('no selector: runs unchanged, no key binding, no scope', async () => {
    const r = recorder();
    const { result, scope } = await runAsAccount(undefined, r.run, async () => [isAlternateAccountScope(), currentAccountScope()]);
    assert.deepEqual(result, [false, null]);
    assert.equal(scope, null);
    assert.deepEqual(r.keys, []);
  });
  it('the default account named explicitly: no key binding, scope marked default', async () => {
    const r = recorder();
    const { result } = await runAsAccount(A, r.run, async () => isAlternateAccountScope());
    assert.equal(result, false);
    assert.deepEqual(r.keys, []);
  });
  it('another account: bound to that account\'s own key, side channels see an alternate scope', async () => {
    const r = recorder();
    const { result, scope } = await runAsAccount(B, r.run, async () => isAlternateAccountScope());
    assert.equal(result, true);
    assert.deepEqual(scope, { email: B, isDefault: false });
    assert.deepEqual(r.keys, [`tok-${B}`]);
    assert.equal(isAlternateAccountScope(), false, 'the scope must not leak past the call');
  });
  it('an unknown account fails before the work runs', async () => {
    let ran = false;
    await assert.rejects(runAsAccount('x@y.zz', recorder().run, async () => { ran = true; }), AccountSelectorError);
    assert.equal(ran, false);
  });
  it('runBoundToAccount always binds explicitly, even for the default', async () => {
    const r = recorder();
    const { scope } = await runBoundToAccount(A, r.run, async () => null);
    assert.deepEqual(r.keys, [`tok-${A}`]);
    assert.equal(scope.isDefault, true);
  });
});

describe('tool plumbing', () => {
  beforeEach(() => sandbox());
  const tools = () => [
    { name: 'save_conversation', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    { name: 'recall_memories', inputSchema: { type: 'object', properties: {} } },
  ];

  it('adds the account property and transfer_memory only with several accounts', async () => {
    const out = withAccountTools(tools(), transferToolDefinition(), {}, []);
    assert.deepEqual(out.map((t) => t.name), ['save_conversation', 'recall_memories', 'transfer_memory']);
    assert.deepEqual(out[0].inputSchema.properties.account.enum, [A, B].sort());
    assert.ok(out[0].inputSchema.properties.title, 'existing properties kept');
    await sandbox([A]);
    assert.deepEqual(withAccountTools(tools(), transferToolDefinition(), {}, []).map((t) => t.name), ['save_conversation', 'recall_memories']);
  });
  it('callOnAccount strips account, labels a non-default result, audits it without the key', async () => {
    const dir = process.env.PURMEMO_CONFIG_DIR;
    const r = recorder();
    let seen;
    const res = await callOnAccount('save_conversation', { title: 't', account: B }, r.run, async (a) => { seen = a; return { content: [{ type: 'text', text: 'saved' }] }; });
    assert.deepEqual(seen, { title: 't' });
    assert.equal(res.content[0].text, `Account: ${B}`);
    const audit = readFileSync(join(dir, 'account-audit.jsonl'), 'utf8');
    assert.match(audit, /"tool":"save_conversation"/);
    assert.match(audit, /"write":true/);
    assert.doesNotMatch(audit, /tok-/);
  });
  it('callOnAccount on the default leaves the result untouched and writes no audit line', async () => {
    const dir = process.env.PURMEMO_CONFIG_DIR;
    const res = await callOnAccount('recall_memories', { query: 'q' }, recorder().run, async () => ({ content: [{ type: 'text', text: 'r' }] }));
    assert.equal(res.content[0].text, 'r');
    assert.equal(existsSync(join(dir, 'account-audit.jsonl')), false);
  });
  it('callOnAccount refuses an unknown account without calling the handler', async () => {
    let called = false;
    const res = await callOnAccount('recall_memories', { account: 'evil@x.com' }, recorder().run, async () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not an account signed in/);
  });
  it('callOnAccount refuses account on a tool that does not take one', async () => {
    const res = await callOnAccount('share_memory', { account: B }, recorder().run, async () => ({}));
    assert.equal(res.isError, true);
    assert.ok(!ACCOUNT_TOOLS.includes('share_memory'));
  });
});

describe('transfer_memory', () => {
  beforeEach(() => sandbox());

  function api(memory = { id: UUID, title: 'Stock x AI notes', conversation_id: 'stock-ai' }, fail = null) {
    const calls = [];
    const makeApiCall = async (endpoint, opts = {}) => {
      calls.push({ endpoint, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (fail && endpoint.endsWith('/transfer')) throw new Error(fail);
      return endpoint.endsWith('/transfer') ? { ok: true } : memory;
    };
    return { calls, makeApiCall };
  }

  it('moves from the default to another account with that account\'s credential', async () => {
    const r = recorder(); const a = api();
    const res = await handleTransferMemory({ memoryId: UUID, to_account: B }, { makeApiCall: a.makeApiCall, runWithApiKey: r.run });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.match(res.content[0].text, /Moved memory .* to work@example.org/);
    const post = a.calls.find((c) => c.method === 'POST');
    assert.equal(post.endpoint, `/api/v1/memories/${UUID}/transfer`);
    assert.equal(post.body.destination_credential, `tok-${B}`);
    assert.deepEqual(r.keys, [], 'source is the default account: no rebinding');
    const audit = readFileSync(join(process.env.PURMEMO_CONFIG_DIR, 'account-audit.jsonl'), 'utf8');
    assert.match(audit, /"tool":"transfer_memory"/);
    assert.doesNotMatch(audit, /tok-/);
  });
  it('moving from a non-default account binds the source key', async () => {
    const r = recorder(); const a = api();
    await handleTransferMemory({ memoryId: UUID, to_account: A, from_account: B }, { makeApiCall: a.makeApiCall, runWithApiKey: r.run });
    assert.deepEqual(r.keys, [`tok-${B}`]);
    assert.equal(a.calls.find((c) => c.method === 'POST').body.destination_credential, `tok-${A}`);
  });
  it('refuses multi-part documents without moving anything', async () => {
    const a = api({ id: UUID, conversation_id: 'big-doc:part:2' });
    const res = await handleTransferMemory({ memoryId: UUID, to_account: B }, { makeApiCall: a.makeApiCall, runWithApiKey: recorder().run });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /multi-part/);
    assert.equal(a.calls.some((c) => c.method === 'POST'), false);
  });
  it('refuses an ordinal id, an unknown account, and a move to the same account, with no network call', async () => {
    for (const args of [{ memoryId: '1', to_account: B }, { memoryId: UUID, to_account: 'x@y.zz' }, { memoryId: UUID, to_account: A }]) {
      const a = api();
      const res = await handleTransferMemory(args, { makeApiCall: a.makeApiCall, runWithApiKey: recorder().run });
      assert.equal(res.isError, true);
      assert.equal(a.calls.length, 0);
    }
  });
  it('a 404 from the server says nothing was moved', async () => {
    const a = api(undefined, 'API Error 404: Memory not found');
    const res = await handleTransferMemory({ memoryId: UUID, to_account: B }, { makeApiCall: a.makeApiCall, runWithApiKey: recorder().run });
    assert.match(res.content[0].text, /has no memory .* Nothing was moved/);
  });
});

/** Start the built server with a config dir, list tools, call one. */
function rpc(configDir, requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: configDir, PURMEMO_CONFIG_DIR: configDir, PURMEMO_API_URL: 'http://127.0.0.1:9', NODE_ENV: 'production', ...extraEnv };
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const want = new Set([0, ...requests.map((r) => r.id)]);
    const got = {}; let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; got ${Object.keys(got)}`)); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && want.has(msg.id)) { got[msg.id] = msg; if (Object.keys(got).length === want.size) { clearTimeout(timer); child.kill(); resolve(got); } }
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n');
  });
}

describe('built server over stdio', () => {
  it('two accounts: account property on core tools, transfer_memory listed; unknown account refused', async () => {
    const dir = await sandbox();
    const res = await rpc(dir, [
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'recall_memories', arguments: { query: 'x', account: 'evil@x.com' } } },
    ]);
    const tools = res[1].result.tools;
    assert.ok(tools.some((t) => t.name === 'transfer_memory'));
    assert.deepEqual(tools.find((t) => t.name === 'save_conversation').inputSchema.properties.account.enum, [A, B].sort());
    assert.equal(res[2].result.isError, true);
    assert.match(res[2].result.content[0].text, /not an account signed in/);
  });
  it('one account: the tool list is exactly as before', async () => {
    const dir = await sandbox([A]);
    const res = await rpc(dir, [{ id: 1, method: 'tools/list' }]);
    const tools = res[1].result.tools;
    assert.equal(tools.some((t) => t.name === 'transfer_memory'), false);
    assert.equal(tools.some((t) => t.inputSchema?.properties?.account), false);
  });
  it('PURMEMO_MULTI_ACCOUNT=0 turns it off (remote mode is covered by the selector tests)', async () => {
    const dir = await sandbox();
    const ok = await rpc(dir, [{ id: 1, method: 'tools/list' }], { PURMEMO_MULTI_ACCOUNT: '0' });
    assert.equal(ok[1].result.tools.some((t) => t.name === 'transfer_memory'), false);
  });
});
