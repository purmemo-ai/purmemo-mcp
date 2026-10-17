import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  extractProjectContext,
  generateIntelligentTitle,
  extractProgressIndicators,
  extractRelationships
} from '../dist/intelligent-memory.js';

describe('Intelligent Memory Content Extraction', () => {

  describe('extractProjectContext', () => {
    it('extracts explicitly tagged project context', () => {
      const content = `
Project: Alpha
Component: Auth
Feature: Login
Phase: Implementation
Status: In Progress
      `;
      const context = extractProjectContext(content);
      // Shape contract: every field present, arrays are arrays, hints object exists.
      for (const k of ['project_name', 'project_component', 'feature_name', 'phase', 'status']) assert.ok(k in context, k);
      assert.ok(Array.isArray(context.technologies) && Array.isArray(context.tools_used));
      assert.strictEqual(typeof context.clustering_hints, 'object');
    });

    it('extracts conversational project context', () => {
        const content = "I am working on Alpha this week. We are implementing the Login feature.";
        const context = extractProjectContext(content);
        assert.ok(context && typeof context === 'object');
        assert.strictEqual(String(context.project_name).toLowerCase(), 'alpha', JSON.stringify(context));
    });
  });

  describe('generateIntelligentTitle', () => {
    it('generates a title from context', () => {
        const context = {
            project_name: 'Alpha',
            feature_name: 'Login',
            project_component: null,
            phase: null,
            status: null
        };
        const title = generateIntelligentTitle(context, "some content");
        assert.ok(title.includes('Alpha'));
    });

    it('generates a title from content fallback', () => {
        const context = {
            project_name: null,
            feature_name: null,
            project_component: null,
            phase: null,
            status: null
        };
        const title = generateIntelligentTitle(context, "I am fixing a bug in the code today.");
        assert.ok(title.includes('bug') || title.includes('fixing') || title.includes('Conversation'), title);
    });
  });

  describe('extractProgressIndicators', () => {
     it('extracts completed and pending items', () => {
        const content = `
✅ task 1
🚧 task 2
❌ task 3
        `;
        const indicators = extractProgressIndicators(content);
        assert.ok(indicators.completed.length > 0);
        assert.ok(indicators.in_progress.length > 0);
        assert.ok(indicators.blocked.length > 0);
     });
  });

  describe('extractRelationships', () => {
     it('extracts related files and dependencies', () => {
         const content = 'This work depends on Memory Search Index. It blocks Dashboard Rollout. It is related to Memory Search.';
         const rels = extractRelationships(content);
         assert.ok(rels.depends_on.some((d) => d.startsWith('Memory Search')), JSON.stringify(rels));
         assert.ok(rels.blocks.some((b) => b.startsWith('Dashboard Rollout')), JSON.stringify(rels));
         assert.ok(rels.related_to.some((r) => r.startsWith('Memory Search')), JSON.stringify(rels));
     });
  });
});
