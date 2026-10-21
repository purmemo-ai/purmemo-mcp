/**
 * Trial count (2026-10-21): one JSON line per routed read, counts only — never
 * the query, never memory text — and a per-day summary with p50/p95.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReadTrialSummary, normalizeReason, recordReadTrial, summarizeReadTrial, trialLine, readTrialFile } from '../dist/lib/read-trial.js';

describe('trialLine / recordReadTrial', () => {
  it('keeps only the counted fields: no query, no preview, no base, account shortened to 8 chars', () => {
    const line = trialLine({ mode: 'hosted', account: '83fcddc9-1234-5678-abcd-ef0123456789', tool: 'recall_memories', served_by: 'live', reason: 'next HTTP 503', ms: 1234, preview: 'SECRET BODY', base: 'http://next', query: 'my secret query' }, () => 0);
    assert.deepEqual(line, { ts: '1970-01-01T00:00:00.000Z', mode: 'hosted', account: '83fcddc9', tool: 'recall_memories', served_by: 'live', ms: 1234, reason: 'HTTP 503' });
    assert.equal(trialLine({ served_by: 'next', tool: 'get_memory_details', ms: 5 }).account, 'local');
  });
  it('normalizes reasons to a few words', () => {
    assert.equal(normalizeReason('next error: This operation was aborted'), 'timeout');
    assert.equal(normalizeReason('next HTTP 501'), 'HTTP 501');
    assert.equal(normalizeReason('next error: fetch failed'), 'error');
    assert.equal(normalizeReason(undefined), null);
  });
  it('appends one line to the file (creating the dir) and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-')); const file = join(dir, 'sub', 'read-trial.jsonl');
    recordReadTrial({ mode: 'hosted', account: 'acct-chris', tool: 'recall_memories', served_by: 'next', ms: 900, query: 'nope' }, { file });
    recordReadTrial({ mode: 'hosted', account: 'acct-chris', tool: 'recall_memories', served_by: 'live', reason: 'next HTTP 503', ms: 20000 }, { file });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2); assert.equal(lines[0].served_by, 'next'); assert.equal(lines[1].reason, 'HTTP 503');
    assert.ok(!readFileSync(file, 'utf8').includes('nope'));
    assert.doesNotThrow(() => recordReadTrial({ served_by: 'next' }, { append: () => { throw new Error('EROFS'); } }));
  });
  it('the file comes from PURMEMO_READ_TRIAL_LOG, else ~/.purmemo/read-trial.jsonl', () => {
    assert.equal(readTrialFile({ PURMEMO_READ_TRIAL_LOG: '/tmp/x.jsonl' }), '/tmp/x.jsonl');
    assert.match(readTrialFile({}), /\.purmemo\/read-trial\.jsonl$/);
  });
});

describe('summarizeReadTrial / formatReadTrialSummary', () => {
  const day = (d, h = 12) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
  const text = [
    { ts: day(20), mode: 'hosted', account: 'acct-chr', tool: 'recall_memories', served_by: 'next', ms: 1000 },
    { ts: day(20), mode: 'hosted', account: 'acct-chr', tool: 'get_memory_details', served_by: 'next', ms: 3000 },
    { ts: day(20), mode: 'local', account: 'local', tool: 'recall_memories', served_by: 'live', ms: 20000, reason: 'timeout' },
    { ts: day(21), mode: 'hosted', account: 'acct-chr', tool: 'recall_memories', served_by: 'next', ms: 2000 },
    { ts: day(1), mode: 'hosted', account: 'old', tool: 'recall_memories', served_by: 'next', ms: 1 },
    'not json',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
  const now = () => Date.UTC(2026, 9, 21, 18);
  it('counts per UTC day inside the window, with p50/p95 for next-served reads and distinct accounts', () => {
    const s = summarizeReadTrial({ text, days: 7, now, file: '/x' });
    assert.equal(s.total, 4); assert.equal(s.unparsable, 1); assert.equal(s.perDay.length, 2);
    const d20 = s.perDay[0];
    assert.deepEqual([d20.day, d20.total, d20.next, d20.live, d20.accounts], ['2026-10-20', 3, 2, 1, 2]);
    assert.deepEqual(d20.reasons, { timeout: 1 }); assert.equal(d20.next_p50_ms, 1000); assert.equal(d20.next_p95_ms, 3000);
    assert.deepEqual(d20.modes, { hosted: 2, local: 1 });
    assert.equal(s.perDay[1].total, 1);
  });
  it('formats one line per day, counts only', () => {
    const out = formatReadTrialSummary(summarizeReadTrial({ text, days: 7, now, file: '/x' }));
    assert.match(out, /^2026-10-20  3 reads · next 2 \(67%\) · live 1 \(timeout ×1\) · next p50 1\.0 s, p95 3\.0 s · 2 accounts · hosted 2, local 1$/m);
    assert.match(out, /4 routed reads in the last 7 day/);
    assert.match(formatReadTrialSummary(summarizeReadTrial({ text: '', days: 1, file: '/x' })), /No routed reads/);
  });
});
