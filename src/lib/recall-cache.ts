/**
 * Per-user cache of the last recall_memories result, used to resolve ordinal
 * memory ids ("1", "2" …) in get_memory_details.
 *
 * Keyed by whatever getBucket() returns — in practice the effective API key
 * from AsyncLocalStorage — so in remote mode one user's recall can never feed
 * another user's ordinal lookup. In stdio mode there is a single key, so the
 * behaviour is exactly the old module-global. Bounded (LRU by insertion) so a
 * long-lived remote process cannot grow it without limit.
 */
export function createLastRecallCache(getBucket: () => string | null | undefined, maxKeys = 500) {
  const byBucket = new Map<string, string[]>();
  const bucket = () => getBucket() || '__anonymous__';
  return {
    get(): string[] { return byBucket.get(bucket()) || []; },
    set(ids: string[]): void {
      const b = bucket();
      byBucket.delete(b); // re-insert so Map order == recency
      byBucket.set(b, ids);
      while (byBucket.size > maxKeys) byBucket.delete(byBucket.keys().next().value as string);
    },
    size(): number { return byBucket.size; },
  };
}
