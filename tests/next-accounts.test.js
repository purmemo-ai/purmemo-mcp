/**
 * Accounts on next (hosted connector, 2026-10-21): the read-base switch is gated
 * per account id. List from env + file (re-read on mtime change), kill switches
 * beat the list, and an unlisted account is never routed and never recorded.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { accountOnNext, createReadCall, nextAccounts, parseAccountList, resetNextAccountsCache } from '../dist/lib/api-client.js';

const body = (tool, args = {}) => JSON.stringify({ tool, arguments: args });
const baseEnv = { PURMEMO_READ_BASE_URL: 'http://next:3211', PURMEMO_NEXT_ACCOUNTS_FILE: '/nonexistent/next-accounts.txt' };
const noKill = () => false;
const noFile = { statMtime: () => null };

beforeEach(() => resetNextAccountsCache());

describe('parseAccountList / nextAccounts', () => {
  it('reads ids from env (comma) and file (lines), ignores blanks and # comments, case-insensitive', () => {
    assert.deepEqual(parseAccountList(' A1, b2 ,,\n# comment\nc3 # trailing\n'), ['a1', 'b2', 'c3']);
    const ids = nextAccounts({ env: { ...baseEnv, PURMEMO_NEXT_ACCOUNTS: 'env-1' }, statMtime: () => 1, readFile: () => '# chris\nFILE-1\n\nfile-2\n' });
    assert.deepEqual([...ids].sort(), ['env-1', 'file-1', 'file-2']);
  });
  it('is empty with no env and no file, and never throws on an unreadable file', () => {
    assert.equal(nextAccounts({ env: baseEnv, ...noFile }).size, 0);
    assert.equal(nextAccounts({ env: baseEnv, statMtime: () => 1, readFile: () => { throw new Error('EACCES'); } }).size, 0);
  });
  it('re-reads the file only when its mtime changes, checking at most every 5 s', () => {
    let t = 0, reads = 0, mtime = 1, now = 1_000_000;
    const deps = { env: baseEnv, statMtime: () => { t++; return mtime; }, readFile: () => { reads++; return mtime === 1 ? 'a' : 'a\nb'; }, now: () => now };
    assert.deepEqual([...nextAccounts(deps)], ['a']); assert.equal(reads, 1);
    now += 1000; nextAccounts(deps); assert.equal(t, 1, 'no stat within 5 s');
    now += 5000; nextAccounts(deps); assert.equal(t, 2); assert.equal(reads, 1, 'same mtime → no re-read');
    mtime = 2; now += 5000; assert.deepEqual([...nextAccounts(deps)].sort(), ['a', 'b']); assert.equal(reads, 2, 'new mtime → re-read');
  });
  it('accountOnNext: membership is exact, trimmed, case-insensitive; empty/null never match', () => {
    const deps = { env: { ...baseEnv, PURMEMO_NEXT_ACCOUNTS: 'Acct-Chris' }, ...noFile };
    assert.equal(accountOnNext('acct-chris', deps), true);
    assert.equal(accountOnNext(' ACCT-CHRIS ', deps), true);
    assert.equal(accountOnNext('acct-chris2', deps), false);
    assert.equal(accountOnNext('', deps), false);
    assert.equal(accountOnNext(null, deps), false);
    assert.equal(accountOnNext(undefined, deps), false);
  });
});

describe('createReadCall with perAccount', () => {
  const listed = { ...baseEnv, PURMEMO_NEXT_ACCOUNTS: 'acct-chris' };
  const nextOk = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'from next' }] }), text: async () => '' });
  const make = (over = {}) => {
    const events = []; let touched = 0;
    const call = createReadCall({
      fetchImpl: async (...a) => { touched++; return nextOk(...a); }, fallback: async () => ({ content: [{ type: 'text', text: 'from live' }] }),
      env: listed, killFileExists: noKill, key: 'k', accountId: 'acct-chris', perAccount: true, accounts: { env: listed, ...noFile },
      onEvent: (e) => events.push(e), ...over
    });
    return { call, events, touched: () => touched };
  };
  const recall = (call) => call('/api/v10/mcp/tools/execute', { method: 'POST', body: body('recall_memories', { query: 'q' }) });

  it('a listed account is served by next, tagged hosted with the account', async () => {
    const m = make();
    assert.equal((await recall(m.call)).content[0].text, 'from next');
    assert.equal(m.events.length, 1); assert.equal(m.events[0].served_by, 'next'); assert.equal(m.events[0].mode, 'hosted'); assert.equal(m.events[0].account, 'acct-chris');
  });
  it('an unlisted account goes straight to live: next never touched, nothing recorded', async () => {
    const m = make({ accountId: 'acct-other' });
    assert.equal((await recall(m.call)).content[0].text, 'from live');
    assert.equal(m.touched(), 0); assert.equal(m.events.length, 0);
  });
  it('an unknown account (null) goes straight to live, untouched', async () => {
    const m = make({ accountId: null });
    assert.equal((await recall(m.call)).content[0].text, 'from live'); assert.equal(m.touched(), 0); assert.equal(m.events.length, 0);
  });
  it('the kill file and DISABLED=1 beat the list', async () => {
    const k = make({ killFileExists: () => true });
    assert.equal((await recall(k.call)).content[0].text, 'from live'); assert.equal(k.touched(), 0);
    const d = make({ env: { ...listed, PURMEMO_READ_BASE_DISABLED: '1' } });
    assert.equal((await recall(d.call)).content[0].text, 'from live'); assert.equal(d.touched(), 0);
  });
  it('without PURMEMO_READ_BASE_URL nothing is routed, listed or not', async () => {
    const env = { PURMEMO_NEXT_ACCOUNTS: 'acct-chris', PURMEMO_NEXT_ACCOUNTS_FILE: '/nonexistent/x' };
    const m = make({ env, accounts: { env, ...noFile } });
    assert.equal((await recall(m.call)).content[0].text, 'from live'); assert.equal(m.touched(), 0);
  });
  it('a listed account still falls back to live when next fails, and the fallback is recorded with a reason', async () => {
    const m = make({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal((await recall(m.call)).content[0].text, 'from live');
    assert.equal(m.events[0].served_by, 'live'); assert.match(m.events[0].reason, /next error/); assert.equal(m.events[0].account, 'acct-chris');
  });
  it('a listed account with a live-only filter, or a non-read tool, goes to live untouched', async () => {
    const m = make();
    assert.equal((await m.call('/api/v10/mcp/tools/execute', { body: body('recall_memories', { query: 'q', intent: 'decision' }) })).content[0].text, 'from live');
    assert.equal((await m.call('/api/v10/mcp/tools/execute', { body: body('save_conversation', {}) })).content[0].text, 'from live');
    assert.equal(m.touched(), 0);
  });
  it('local mode (no perAccount) is unchanged: routes on the env alone, tagged local', async () => {
    const events = [];
    const call = createReadCall({ fetchImpl: nextOk, fallback: async () => 'live', env: baseEnv, killFileExists: noKill, key: 'k', onEvent: (e) => events.push(e) });
    assert.equal((await recall(call)).content[0].text, 'from next'); assert.equal(events[0].mode, 'local'); assert.equal(events[0].account, null);
  });
});
