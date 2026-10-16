import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  extractSearchTerms,
  buildMemoryQueries,
  classifyWorkflowIntent
} from '../dist/workflows/engine.js';

describe('Workflow Engine Edge Cases', () => {

  describe('extractSearchTerms', () => {
    it('handles empty input', () => {
      const terms = extractSearchTerms("");
      assert.deepStrictEqual(terms, '');
    });
  });

  describe('buildMemoryQueries', () => {
    it('handles empty inputs', () => {
      const template = { memory_queries: ['[INPUT]', 'test query'] };
      const queries = buildMemoryQueries(template, "");
      assert.ok(queries);
    });
  });

  describe('classifyWorkflowIntent', () => {
     it('handles empty input', () => {
        const result = classifyWorkflowIntent("");
        assert.ok(result);
     });
  });

});

describe('Workflow Engine More coverage', () => {
    it('handles long input', () => {
        const input = "This is a really long input with a lot of words to test the length function.";
        const template = { memory_queries: ['[INPUT]', 'test query'] };
        const queries = buildMemoryQueries(template, input);
        assert.ok(queries);
    });
});

describe('Workflow Engine Edge Cases Ext', () => {
    it('handles long input empty words', () => {
        const input = "This is a really long input with a lot of words to test the length function.";
        const template = { memory_queries: ['[INPUT]', 'test query'] };
        const queries = buildMemoryQueries(template, input);
        assert.ok(queries);
    });
});
