/**
 * Read routing cache (hosted connector, 2026-10-21): the "reads from next" flag
 * lives on the account in next's database; the connector only caches next's
 * answer per key hash and never waits for it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRoutingCache, ROUTING_TTL_MS, ROUTING_NEG_TTL_MS } from '../dist/lib/api-client.js';

const env = { PURMEMO_READ_BASE_URL: 'http://next:3211' };
const noKill = () => false;
const answer = (backend, status = 200) => async () => ({ ok: status < 400, status, json: async () => ({ ok: true, backend }), text: async () => '' });
const make = (fetchImpl, over = {}) => {
  let t = 1_000_000; const calls = []; const events = [];
  const cache = createRoutingCache({ fetchImpl: async (url, init) => { calls.push({ url, bearer: init.headers.Authorization }); return fetchImpl(url, init); }, env, killFileExists: noKill, now: () => t, onEvent: (e) => events.push(e), ...over });
  return { cache, calls, events, tick: (ms) => { t += ms; } };
};

describe('createRoutingCache', () => {
  it('knows nothing until a prefetch lands; then answers from the cache without another call', async () => {
    const m = make(answer('next'));
    assert.equal(m.cache.get('k1'), null);
    m.cache.prefetch('k1'); await m.cache.settle();
    assert.equal(m.cache.get('k1'), 'next');
    assert.equal(m.calls.length, 1); assert.equal(m.calls[0].url, 'http://next:3211/api/v1/read-routing/me'); assert.equal(m.calls[0].bearer, 'Bearer k1');
    m.cache.prefetch('k1'); await m.cache.settle(); assert.equal(m.calls.length, 1, 'fresh → no new call');
    assert.equal(m.events[0].backend, 'next');
  });
  it('a live answer is cached too; the answer expires after the TTL and is re-fetched on the next prefetch', async () => {
    const m = make(answer('live'));
    m.cache.prefetch('k2'); await m.cache.settle(); assert.equal(m.cache.get('k2'), 'live');
    m.tick(ROUTING_TTL_MS + 1); assert.equal(m.cache.get('k2'), null);
    m.cache.prefetch('k2'); await m.cache.settle(); assert.equal(m.calls.length, 2);
  });
  it('a failed lookup (network, 5xx, garbage body) reads as live for a minute, then is retried', async () => {
    for (const bad of [async () => { throw new Error('ECONNREFUSED'); }, answer('next', 503), async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }), text: async () => '' })]) {
      const m = make(bad);
      m.cache.prefetch('k3'); await m.cache.settle();
      assert.equal(m.cache.get('k3'), 'live'); assert.match(m.events[0].reason, /routing/);
      m.tick(ROUTING_NEG_TTL_MS + 1); assert.equal(m.cache.get('k3'), null);
    }
  });
  it('two prefetches in flight for one key make one call', async () => {
    let resolve; const m = make(() => new Promise((r) => { resolve = r; }));
    m.cache.prefetch('k4'); m.cache.prefetch('k4');
    assert.equal(m.calls.length, 1);
    resolve({ ok: true, status: 200, json: async () => ({ backend: 'next' }), text: async () => '' }); await m.cache.settle();
    assert.equal(m.cache.get('k4'), 'next');
  });
  it('markLive (after a 501 not_on_next) overrides a cached next until the TTL', async () => {
    const m = make(answer('next'));
    m.cache.prefetch('k5'); await m.cache.settle(); assert.equal(m.cache.get('k5'), 'next');
    m.cache.markLive('k5'); assert.equal(m.cache.get('k5'), 'live');
    m.cache.prefetch('k5'); await m.cache.settle(); assert.equal(m.calls.length, 1, 'no re-fetch while the live mark is fresh');
  });
  it('with the switch off (no env) or the kill file present, nothing is fetched and nothing is known', async () => {
    const a = make(answer('next'), { env: {} }); a.cache.prefetch('k6'); await a.cache.settle(); assert.equal(a.calls.length, 0); assert.equal(a.cache.get('k6'), null);
    const b = make(answer('next'), { killFileExists: () => true }); b.cache.prefetch('k6'); await b.cache.settle(); assert.equal(b.calls.length, 0);
  });
  it('keys are never stored: the cache holds hashes', async () => {
    const m = make(answer('next')); m.cache.prefetch('sk-secret-key'); await m.cache.settle();
    assert.equal(m.cache._size(), 1); assert.ok(!JSON.stringify([...m.events]).includes('sk-secret'));
  });
});
