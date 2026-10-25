/**
 * Server log for routed reads (2026-10-25): the account id is shortened to
 * 8 chars, the same as the trial file, so the hosted log never holds a full id.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readBaseLogFields } from '../dist/lib/api-client.js';

describe('readBaseLogFields', () => {
  it('shortens a full account id to 8 chars and keeps every other field', () => {
    const e = { mode: 'hosted', account: '982d25cd-1234-5678-abcd-ef0123456789', served_by: 'next', tool: 'recall_memories', ms: 12 };
    assert.deepEqual(readBaseLogFields(e), { ...e, account: '982d25cd' });
    assert.equal(e.account, '982d25cd-1234-5678-abcd-ef0123456789', 'input not mutated');
  });
  it('a missing account reads unknown (hosted) or local, like the trial file', () => {
    assert.equal(readBaseLogFields({ mode: 'hosted', account: null }).account, 'unknown');
    assert.equal(readBaseLogFields({ mode: 'local', account: null }).account, 'local');
  });
  it('events without an account field pass through unchanged', () => {
    const e = { backend: 'next', ms: 3 };
    assert.equal(readBaseLogFields(e), e);
  });
});
