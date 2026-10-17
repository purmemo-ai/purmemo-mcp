import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';

let apiCalls = [];
const mockMakeApiCall = mock.fn(async (path, opts) => {
  apiCalls.push({ path, opts });
  if (path.includes('/api/v1/memories/')) {
    return { id: 'mem_123', memory_id: 'mem_123', updated: false };
  }
  if (path.includes('/api/v1/projects/')) {
      if (path.includes('/test_results')) return { status: 'success', project_name: 'test', id: '123', linked_task: null };
  }
  return { success: true };
});

mock.module('../dist/lib/api-client.js', {
  namedExports: {
    makeApiCall: mockMakeApiCall,
    sanitizeUnicode: (s) => s,
    safeErrorMessage: (e) => e?.message || 'unknown',
    wafSafeBody: (body) => body,
    getEffectiveApiKey: () => 'test-key',
    makeReadCall: mockMakeApiCall,
  },
});

const { handleSaveArtifact, handleCommit, handleSnapshotSources, handleSaveSnapshot, handleAcceptSnapshot, handleGetSnapshot, handleGetNextTask, handleCompleteTask, handleSaveInvestigation, handleRunWorkflow, handleListWorkflows, handleWhatChanged, handleGetMemoryDetails, handleShareMemory, handleGetPublicMemory, handleReportMemory, handleGetArtifacts, handleGetTestResults, handleSaveTestResult, initHandlers } = await import('../dist/tools/handlers.js');

initHandlers({
  platform: 'claude-code',
  getLastRecallIds: () => [],
  setLastRecallIds: () => {},
  readCurrentSessionId: () => 'test-session-id',
});

function reset() {
  apiCalls = [];
  mockMakeApiCall.mock.restore();
}

const VALID_CONTENT = 'x'.repeat(150);

describe('Tool Handlers Validation', () => {
  it('handleSaveArtifact rejects missing fields', async () => {
    reset();
    const result = await handleSaveArtifact({ title: 'test', content: VALID_CONTENT });
    assert.match(result.content[0].text, /Missing or invalid fields/);
  });

  it('handleCommit rejects invalid fields', async () => {
    reset();
    const result = await handleCommit({ title: 'test', content: VALID_CONTENT, commitment_type: 'INVALID_TYPE' });
    assert.match(result.content[0].text, /Missing or invalid fields/);
  });

  it('handleSnapshotSources rejects missing topic', async () => {
    reset();
    const result = await handleSnapshotSources({});
    assert.match(result.content[0].text, /Missing required field: topic/);
  });

  it('handleSaveSnapshot rejects short content', async () => {
    reset();
    const result = await handleSaveSnapshot({ topic: 'test', content: 'short', cited_ids: ['id1'] });
    assert.match(result.content[0].text, /content too short/);
  });

  it('handleAcceptSnapshot rejects missing snapshot_id', async () => {
    reset();
    const result = await handleAcceptSnapshot({});
    assert.match(result.content[0].text, /Missing required field: snapshot_id/);
  });

  it('handleGetSnapshot rejects missing both', async () => {
    reset();
    const result = await handleGetSnapshot({});
    assert.match(result.content[0].text, /Provide either topic or snapshot_id/);
  });

  it('handleGetNextTask rejects missing project_name', async () => {
    reset();
    const result = await handleGetNextTask({});
    assert.match(result.content[0].text, /Missing required field: project_name/);
  });

  it('handleCompleteTask rejects missing fields', async () => {
    reset();
    let result = await handleCompleteTask({ verification_summary: 'test', project_name: 'test' });
    assert.match(result.content[0].text, /Missing required field: task_id/);
  });

  it('handleSaveInvestigation rejects missing incident_id', async () => {
    reset();
    const result = await handleSaveInvestigation({});
    assert.match(result.content[0].text, /Missing required field: incident_id/);
  });

  it('handleRunWorkflow rejects unknown workflow', async () => {
    reset();
    const result = await handleRunWorkflow({ workflow: 'unknown_wf' });
    assert.match(result.content[0].text, /Unknown workflow: "unknown_wf"/);
  });

  it('handleListWorkflows returns list', async () => {
    reset();
    const result = await handleListWorkflows({});
    assert.match(result.content[0].text, /Purmemo Workflows/);
  });

  it('handleWhatChanged rejects missing entity', async () => {
    reset();
    const result = await handleWhatChanged({});
    assert.match(result.content[0].text, /needs an entity name/);
  });

  it('handleGetMemoryDetails rejects invalid ID', async () => {
    reset();
    const result = await handleGetMemoryDetails({ memoryId: 'invalid' });
    assert.match(result.content[0].text, /Invalid memory ID: "invalid"/);
  });

  it('handleShareMemory rejects missing ID', async () => {
    reset();
    const result = await handleShareMemory({});
    assert.match(result.content[0].text, /Missing required parameter: memory_id/);
  });

  it('handleGetPublicMemory rejects missing ID', async () => {
    reset();
    const result = await handleGetPublicMemory({});
    assert.match(result.content[0].text, /Missing required parameter: memory_id/);
  });

  it('handleReportMemory rejects missing ID', async () => {
    reset();
    const result = await handleReportMemory({});
    assert.match(result.content[0].text, /Missing required parameter: memory_id/);
  });

  it('handleGetArtifacts rejects missing parent', async () => {
    reset();
    const result = await handleGetArtifacts({});
    assert.match(result.content[0].text, /Missing required field: parent_conversation_id/);
  });

  it('handleGetTestResults rejects missing project_name', async () => {
    reset();
    const result = await handleGetTestResults({});
    assert.match(result.content[0].text, /Missing required field: project_name/);
  });

  it('handleSaveTestResult rejects missing fields', async () => {
    reset();
    let result = await handleSaveTestResult({ test_suite: 'test', passed: true });
    assert.match(result.content[0].text, /Missing required fields: project_name and test_suite/);
  });
});
