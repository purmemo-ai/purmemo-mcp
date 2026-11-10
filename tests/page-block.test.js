// The page block of a recall answer (src/lib/page-block.ts): taken off the front, shown unchanged, never parsed as a
// search result; an answer without one is untouched.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { splitPageBlock, PAGE_BLOCK_MAX_CHARS } from '../dist/lib/page-block.js';

const RESULTS = 'Found 1 memories for "x":\n\n1. **A memory**\n   Relevance: 61.0%\n   Platform: claude\n   Preview: p...\n   ID: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE = '=== PAGE: cosmo/attn (purmemo page, built 2026-11-09, v2) ===\nWhat exists\n- One attention system. [S1]\nSources: S1 = memory a60c5e7e-eda7-4192-b929-f856ec289aeb "cosmo/attn **living** doc"\n=== END PAGE ===';

describe('splitPageBlock', () => {
  it('takes a leading page block off the answer and leaves the results exactly as they were', () => {
    const r = splitPageBlock(`${PAGE}\n\n${RESULTS}`);
    assert.strictEqual(r.page, PAGE);
    assert.strictEqual(r.rest, RESULTS);
  });
  it('an answer without a page block is returned untouched', () => {
    assert.deepStrictEqual(splitPageBlock(RESULTS), { page: '', rest: RESULTS });
    assert.deepStrictEqual(splitPageBlock(''), { page: '', rest: '' });
    assert.deepStrictEqual(splitPageBlock(undefined), { page: '', rest: '' });
  });
  it('only a complete block at the very start counts', () => {
    const later = `${RESULTS}\n\n${PAGE}`;
    assert.deepStrictEqual(splitPageBlock(later), { page: '', rest: later });
    const open = `=== PAGE: x ===\nno closing fence\n\n${RESULTS}`;
    assert.deepStrictEqual(splitPageBlock(open), { page: '', rest: open });
  });
  it('the block is never parsed as a search result, even when it carries bold text and ids', () => {
    const { rest } = splitPageBlock(`${PAGE}\n\n${RESULTS}`);
    const blocks = rest.split('\n\n').filter((b) => b.includes('**') && /[0-9a-f]{8}-[0-9a-f]{4}/.test(b)); // the handler's own filter
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].includes('A memory'));
  });
  it('an oversized block is dropped, and the results still come through', () => {
    const big = `=== PAGE: x ===\n${'y'.repeat(PAGE_BLOCK_MAX_CHARS)}\n=== END PAGE ===`;
    assert.deepStrictEqual(splitPageBlock(`${big}\n\n${RESULTS}`), { page: '', rest: RESULTS });
  });
  it('a page with no results after it', () => {
    assert.deepStrictEqual(splitPageBlock(PAGE), { page: PAGE, rest: '' });
  });
});
