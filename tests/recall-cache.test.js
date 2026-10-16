/**
 * Ordinal cache isolation (2026-10-16 hardening): the last-recall ids used for
 * "1", "2" … lookups are keyed by the effective API key, so two users served by
 * one remote process can never see each other's ordinals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createLastRecallCache } from '../dist/lib/recall-cache.js';
import { runWithApiKey, getEffectiveApiKey } from '../dist/lib/api-client.js';

describe('createLastRecallCache', () => {
  it('isolates buckets per effective API key across async contexts', async () => {
    const cache = createLastRecallCache(() => getEffectiveApiKey());
    await runWithApiKey('key-A', async () => cache.set(['a-1', 'a-2']));
    await runWithApiKey('key-B', async () => {
      assert.deepEqual(cache.get(), [], 'B must not see A\'s recall');
      cache.set(['b-1']);
    });
    await runWithApiKey('key-A', async () => assert.deepEqual(cache.get(), ['a-1', 'a-2']));
    assert.deepEqual(cache.get(), [], 'no key → anonymous bucket, empty');
  });
  it('two users interleaved across awaits still only see their own ids', async () => {
    const cache = createLastRecallCache(() => getEffectiveApiKey());
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await Promise.all([
      runWithApiKey('key-A', async () => { cache.set(['a-1']); await tick(); await tick(); assert.deepEqual(cache.get(), ['a-1']); }),
      runWithApiKey('key-B', async () => { await tick(); cache.set(['b-1']); await tick(); assert.deepEqual(cache.get(), ['b-1']); }),
    ]);
  });
  it('behaves like a single global when there is only one key (stdio mode)', () => {
    const cache = createLastRecallCache(() => 'only-key');
    cache.set(['x']); assert.deepEqual(cache.get(), ['x']);
    cache.set(['y']); assert.deepEqual(cache.get(), ['y']);
    assert.equal(cache.size(), 1);
  });
  it('is bounded, evicting the least recently set key', () => {
    let k = 'k0'; const cache = createLastRecallCache(() => k, 2);
    k = 'k1'; cache.set(['1']); k = 'k2'; cache.set(['2']); k = 'k1'; cache.set(['1b']); k = 'k3'; cache.set(['3']);
    assert.equal(cache.size(), 2);
    k = 'k2'; assert.deepEqual(cache.get(), [], 'k2 was least recent → evicted');
    k = 'k1'; assert.deepEqual(cache.get(), ['1b']);
  });
});
