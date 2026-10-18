/**
 * what_changed — the first purmemo-next-only tool (2026-09-12): formats the
 * ledger's dossier history (superseded facts with what replaced each, open
 * contradictions) for a founder asking "what changed about X".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatWhatChanged, nextBaseUrl } from '../dist/tools/handlers.js';

const dossier = {
  entity: { id: 'e1', canonical_name: 'purmemo-next' },
  members: [{ canonical_name: 'purmemo-next' }, { canonical_name: 'purmemo_next' }, { canonical_name: 'purmemo Next' }],
  claim_count: 189, history_count: 2, contradiction_count: 1,
  history: [
    { statement: "purmemo-next's data stays on managed Supabase.", temporal_key: 'hosting', valid_to: '2026-08-10T00:00:00Z', replaced_by: "purmemo-next's database migrated to the Mac mini's Postgres." },
    { statement: 'The shadow line is MacBook-only.', temporal_key: 'config', valid_to: '2026-09-07T00:00:00Z', replaced_by: 'The shadow pipeline is server-side (fireApiShadow).' },
  ],
  contradictions: [{ claim_a: 'A says X', claim_b: 'B says not X' }],
};

describe('formatWhatChanged', () => {
  it('leads with the name and aliases, counts, then dated changes newest-first with replacements, then contradictions', () => {
    const t = formatWhatChanged({ canonical_name: 'purmemo-next' }, dossier, 10);
    assert.match(t, /What changed about \*\*purmemo-next\*\* \(also: purmemo_next, purmemo Next\)/);
    assert.match(t, /Current facts: 189 · superseded: 2 · open contradictions: 1/);
    assert.match(t, /• 2026-08-10 \[hosting\]: purmemo-next's data stays on managed Supabase\./);
    assert.match(t, /→ now: purmemo-next's database migrated to the Mac mini's Postgres\./);
    assert.match(t, /Open contradictions/); assert.match(t, /entity id: e1/);
  });
  it('respects the limit and says how many older changes are hidden', () => {
    const t = formatWhatChanged(null, { ...dossier, history_count: 2 }, 1);
    assert.match(t, /1 older change\(s\) not shown/);
    assert.doesNotMatch(t, /MacBook-only/);
  });
  it('is honest when nothing has been superseded', () => {
    const t = formatWhatChanged({ canonical_name: 'x' }, { entity: { id: 'e', canonical_name: 'x' }, members: [], claim_count: 3, history_count: 0, contradiction_count: 0, history: [], contradictions: [] });
    assert.match(t, /No superseded facts on record yet/);
  });
});

describe('nextBaseUrl', () => {
  it('defaults to the public next address (the old localhost:3210 default answered nowhere)', () => {
    assert.equal(nextBaseUrl({}), 'https://next.purmemo.ai');
    assert.equal(nextBaseUrl({ PURMEMO_SHADOW_DOOR_URL: 'http://host:3210/save' }), 'https://next.purmemo.ai');
  });
  it('PURMEMO_NEXT_URL wins, then the read base, then the sessions URL; trailing slashes trimmed', () => {
    assert.equal(nextBaseUrl({ PURMEMO_NEXT_URL: 'http://n:1/', PURMEMO_READ_BASE_URL: 'http://r:2' }), 'http://n:1');
    assert.equal(nextBaseUrl({ PURMEMO_READ_BASE_URL: 'http://127.0.0.1:3211/' }), 'http://127.0.0.1:3211');
    assert.equal(nextBaseUrl({ PURMEMO_SESSIONS_URL: 'https://s.example' }), 'https://s.example');
  });
});
