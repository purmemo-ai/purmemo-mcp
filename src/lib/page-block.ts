/**
 * The page block of a recall answer (2026-11-09).
 *
 * purmemo's read host may lead a recall_memories answer with ONE fenced block — the cited page purmemo keeps for the
 * thing the query is about ("=== PAGE: <title> … ===" … "=== END PAGE ==="), then the search results. This connector
 * re-renders the search results from the text, which used to drop the block. splitPageBlock takes it off the front so
 * the handler can show it unchanged above the results and parse only the results.
 *
 * Only a block at the very start counts, and only a complete one (both fences). Anything else is left alone, so an
 * answer without a page — every answer for an account without pages, and every answer from the older API host — is
 * returned as `rest` byte for byte.
 */
const PAGE_BLOCK_RE = /^=== PAGE: [^\n]* ===\n[\s\S]*?\n=== END PAGE ===(?:\n\n|\n|$)/;
/** A block longer than this is not shown (the read host caps it near 3,000 characters). */
export const PAGE_BLOCK_MAX_CHARS = 6000;

export function splitPageBlock(text: string): { page: string; rest: string } {
  const s = typeof text === 'string' ? text : '';
  const m = PAGE_BLOCK_RE.exec(s);
  if (!m) return { page: '', rest: s };
  const page = m[0].trimEnd();
  return { page: page.length > PAGE_BLOCK_MAX_CHARS ? '' : page, rest: s.slice(m[0].length) };
}
