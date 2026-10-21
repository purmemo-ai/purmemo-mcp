/**
 * Trial count (2026-10-21): one JSON line per routed read, counts only — never
 * the query, never memory text — in one file per UTC day, pruned after the
 * retention window, and a per-day summary with p50/p95.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReadTrialSummary, normalizeReason, recordReadTrial, summarizeReadTrial, trialLine, readTrialFile, trialFileFor, trialFiles, pruneTrialFiles, keepDays } from '../dist/lib/read-trial.js';

const at = (iso) => () => Date.parse(iso);

describe('trialLine / recordReadTrial', () => {
  it('keeps only the counted fields: no query, no preview, no base, account shortened to 8 chars', () => {
    const line = trialLine({ mode: 'hosted', account: '83fcddc9-1234-5678-abcd-ef0123456789', tool: 'recall_memories', served_by: 'live', reason: 'next HTTP 503', ms: 1234, preview: 'SECRET BODY', base: 'http://next', query: 'my secret query' }, () => 0);
    assert.deepEqual(line, { ts: '1970-01-01T00:00:00.000Z', mode: 'hosted', account: '83fcddc9', tool: 'recall_memories', served_by: 'live', ms: 1234, reason: 'HTTP 503' });
    assert.equal(trialLine({ served_by: 'next', tool: 'get_memory_details', ms: 5 }).account, 'local');
    assert.equal(trialLine({ mode: 'hosted', served_by: 'next', ms: 5 }).account, 'unknown');
  });
  it('normalizes reasons to a few words', () => {
    assert.equal(normalizeReason('next error: This operation was aborted'), 'timeout');
    assert.equal(normalizeReason('next HTTP 501'), 'HTTP 501');
    assert.equal(normalizeReason('next error: fetch failed'), 'error');
    assert.equal(normalizeReason(undefined), null);
  });
  it("appends to today's dated file (creating the dir), never throws, and keeps the query out", () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-')); const base = join(dir, 'sub', 'read-trial.jsonl');
    recordReadTrial({ mode: 'hosted', account: 'acct-chris', tool: 'recall_memories', served_by: 'next', ms: 900, query: 'nope' }, { file: base, now: at('2026-10-21T12:00:00Z') });
    recordReadTrial({ mode: 'hosted', account: 'acct-chris', tool: 'recall_memories', served_by: 'live', reason: 'next HTTP 503', ms: 20000 }, { file: base, now: at('2026-10-22T01:00:00Z') });
    const f21 = join(dir, 'sub', 'read-trial.2026-10-21.jsonl'), f22 = join(dir, 'sub', 'read-trial.2026-10-22.jsonl');
    assert.equal(trialFileFor(base, at('2026-10-21T23:59:59Z')), f21);
    assert.ok(existsSync(f21) && existsSync(f22) && !existsSync(base));
    assert.equal(JSON.parse(readFileSync(f21, 'utf8')).served_by, 'next'); assert.equal(JSON.parse(readFileSync(f22, 'utf8')).reason, 'HTTP 503');
    assert.ok(!readFileSync(f21, 'utf8').includes('nope'));
    assert.deepEqual(trialFiles(base), [f21, f22]);
    assert.doesNotThrow(() => recordReadTrial({ served_by: 'next' }, { append: () => { throw new Error('EROFS'); } }));
  });
  it('prunes dated files older than the retention window and leaves the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-')); const base = join(dir, 'read-trial.jsonl');
    for (const d of ['2026-09-01', '2026-09-20', '2026-10-21']) writeFileSync(join(dir, `read-trial.${d}.jsonl`), '{}\n');
    writeFileSync(base, '{}\n'); // legacy undated file is listed first and never pruned
    const gone = pruneTrialFiles(base, 30, at('2026-10-21T12:00:00Z'));
    assert.deepEqual(gone.map((f) => f.split('/').pop()), ['read-trial.2026-09-01.jsonl', 'read-trial.2026-09-20.jsonl']);
    assert.deepEqual(trialFiles(base).map((f) => f.split('/').pop()), ['read-trial.jsonl', 'read-trial.2026-10-21.jsonl']);
  });
  it('the base and the retention come from the env, with defaults', () => {
    assert.equal(readTrialFile({ PURMEMO_READ_TRIAL_LOG: '/tmp/x.jsonl' }), '/tmp/x.jsonl');
    assert.match(readTrialFile({}), /\.purmemo\/read-trial\.jsonl$/);
    assert.equal(keepDays({}), 30); assert.equal(keepDays({ PURMEMO_READ_TRIAL_KEEP_DAYS: '7' }), 7); assert.equal(keepDays({ PURMEMO_READ_TRIAL_KEEP_DAYS: 'x' }), 30);
  });
});

describe('summarizeReadTrial / formatReadTrialSummary', () => {
  const day = (d, h = 12) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
  const rows = [
    { ts: day(20), mode: 'hosted', account: 'acct-chr', tool: 'recall_memories', served_by: 'next', ms: 1000 },
    { ts: day(20), mode: 'hosted', account: 'acct-chr', tool: 'get_memory_details', served_by: 'next', ms: 3000 },
    { ts: day(20), mode: 'local', account: 'local', tool: 'recall_memories', served_by: 'live', ms: 20000, reason: 'timeout' },
    { ts: day(21), mode: 'hosted', account: 'acct-chr', tool: 'recall_memories', served_by: 'next', ms: 2000 },
    { ts: day(1), mode: 'hosted', account: 'old', tool: 'recall_memories', served_by: 'next', ms: 1 },
    'not json',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  const text = rows.join('\n') + '\n';
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
  it('reads across the dated files of a base path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-')); const base = join(dir, 'read-trial.jsonl');
    writeFileSync(join(dir, 'read-trial.2026-10-20.jsonl'), rows.slice(0, 3).join('\n') + '\n');
    writeFileSync(join(dir, 'read-trial.2026-10-21.jsonl'), rows[3] + '\n');
    const s = summarizeReadTrial({ file: base, days: 7, now });
    assert.equal(s.total, 4); assert.equal(s.perDay.length, 2);
  });
  it('formats one line per day, counts only', () => {
    const out = formatReadTrialSummary(summarizeReadTrial({ text, days: 7, now, file: '/x' }));
    assert.match(out, /^2026-10-20  3 reads · next 2 \(67%\) · live 1 \(timeout ×1\) · next p50 1\.0 s, p95 3\.0 s · 2 accounts · hosted 2, local 1$/m);
    assert.match(out, /4 routed reads in the last 7 day/);
    assert.match(formatReadTrialSummary(summarizeReadTrial({ text: '', days: 1, file: '/x' })), /No routed reads/);
  });
});
