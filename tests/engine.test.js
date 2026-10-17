import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  extractSearchTerms,
  buildMemoryQueries,
  classifyWorkflowIntent
} from '../dist/workflows/engine.js';

describe('Workflow Engine', () => {
  it('extractSearchTerms returns an empty string for empty input', () => {
    assert.strictEqual(extractSearchTerms(''), '');
  });

  it('buildMemoryQueries substitutes [INPUT] and keeps literal queries', () => {
    const template = { memory_queries: ['[INPUT]', 'test query'] };
    const queries = buildMemoryQueries(template, 'release planning for purmemo');
    assert.ok(Array.isArray(queries));
    assert.strictEqual(queries.length, 2);
    assert.ok(queries.some((q) => q.includes('purmemo')), 'input terms appear in a query');
    assert.ok(queries.includes('test query'), 'literal query preserved');
    assert.ok(!queries.some((q) => q.includes('[INPUT]')), 'placeholder is replaced');
  });

  it('buildMemoryQueries with empty input does not emit the raw placeholder', () => {
    const queries = buildMemoryQueries({ memory_queries: ['[INPUT]', 'test query'] }, '');
    assert.ok(Array.isArray(queries));
    assert.ok(!queries.some((q) => q.includes('[INPUT]')));
  });

  it('classifyWorkflowIntent returns no workflow for empty input and a high-confidence match for a clear signal', () => {
    assert.deepStrictEqual(classifyWorkflowIntent(''), { workflow: null, confidence: 'none', chain: [] });
    const hit = classifyWorkflowIntent('production is down, we have an incident');
    assert.strictEqual(hit.workflow, 'incident');
    assert.strictEqual(hit.confidence, 'high');
    assert.ok(Array.isArray(hit.chain));
  });
});
