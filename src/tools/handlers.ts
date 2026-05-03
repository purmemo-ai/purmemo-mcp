// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * Tool handlers for purmemo MCP server.
 *
 * Extracted from server.ts — 14 handlers + 6 helpers.
 * Call initHandlers() once at startup to inject server-scoped dependencies.
 */

import { structuredLog } from '../lib/logger.js';
import { makeApiCall, sanitizeUnicode, safeErrorMessage, wafSafeBody } from '../lib/api-client.js';
import {
  extractProjectContext,
  generateIntelligentTitle,
  extractProgressIndicators,
  extractRelationships
} from '../intelligent-memory.js';
import {
  WORKFLOW_TEMPLATES,
  classifyWorkflowIntent,
  buildMemoryQueries
} from '../workflows/engine.js';

// ============================================================================
// Module state — set via initHandlers()
// ============================================================================

let PLATFORM = 'claude';
let readCurrentSessionId: () => string | null = () => null;

export function initHandlers(deps: {
  platform: string;
  getLastRecallIds: () => string[];
  setLastRecallIds: (ids: string[]) => void;
  readCurrentSessionId: () => string | null;
}) {
  PLATFORM = deps.platform;
  _getLastRecallIds = deps.getLastRecallIds;
  _setLastRecallIds = deps.setLastRecallIds;
  readCurrentSessionId = deps.readCurrentSessionId;
}

// lastRecallIds is mutable shared state — use getter/setter to keep server.ts as owner
let _getLastRecallIds: () => string[] = () => lastRecallIds;
let _setLastRecallIds: (ids: string[]) => void = (ids) => { lastRecallIds = ids; };

// ============================================================================
// Content helpers
// ============================================================================

function extractContentMetadata(content) {
  const metadata = {
    characterCount: content.length,
    wordCount: content.split(/\s+/).length,
    hasCodeBlocks: false,
    codeBlockCount: 0,
    hasArtifacts: false,
    artifactCount: 0,
    hasUrls: false,
    urlCount: 0,
    hasFilePaths: false,
    filePathCount: 0,
    conversationTurns: 0
  };

  // Count code blocks
  const codeMatches = content.match(/```[\s\S]*?```/g);
  if (codeMatches) {
    metadata.hasCodeBlocks = true;
    metadata.codeBlockCount = codeMatches.length;
  }

  // Count conversation turns (USER:/ASSISTANT: patterns)
  const turnMatches = content.match(/(USER|ASSISTANT):/g);
  if (turnMatches) {
    metadata.conversationTurns = turnMatches.length;
  }

  // Count URLs
  const urlMatches = content.match(/https?:\/\/[^\s]+/g);
  if (urlMatches) {
    metadata.hasUrls = true;
    metadata.urlCount = urlMatches.length;
  }

  // Count file paths
  const pathMatches = content.match(/[\/~][\w\-.\/]+\.\w+/g);
  if (pathMatches) {
    metadata.hasFilePaths = true;
    metadata.filePathCount = pathMatches.length;
  }

  // Check for artifacts section
  if (content.includes('=== ARTIFACTS ===') || content.includes('ARTIFACT:')) {
    metadata.hasArtifacts = true;
    // Rough count of artifacts
    const artifactSections = content.match(/ARTIFACT:|=== ARTIFACTS ===/g);
    metadata.artifactCount = artifactSections ? artifactSections.length : 1;
  }

  return metadata;
}

function shouldChunk(content) {
  // Auto-chunk if content is over 15K characters
  return content.length > 15000;
}

function chunkContent(content, maxChunkSize = 20000) {
  const chunks = [];
  let currentPos = 0;

  while (currentPos < content.length) {
    let chunkEnd = Math.min(currentPos + maxChunkSize, content.length);

    // Try to break at natural boundaries (paragraph, section, etc.)
    if (chunkEnd < content.length) {
      // Look for good break points within the last 1000 chars of the chunk
      const searchStart = Math.max(chunkEnd - 1000, currentPos);
      const segment = content.slice(searchStart, chunkEnd);

      // Try to break at section markers first
      const sectionBreak = segment.lastIndexOf('\n===');
      if (sectionBreak !== -1) {
        chunkEnd = searchStart + sectionBreak;
      } else {
        // Try to break at conversation turns
        const conversationBreak = segment.lastIndexOf('\nUSER:');
        if (conversationBreak !== -1) {
          chunkEnd = searchStart + conversationBreak;
        } else {
          // Break at paragraph
          const paragraphBreak = segment.lastIndexOf('\n\n');
          if (paragraphBreak !== -1) {
            chunkEnd = searchStart + paragraphBreak;
          }
        }
      }
    }

    const chunk = content.slice(currentPos, chunkEnd);
    chunks.push(chunk);
    currentPos = chunkEnd;
  }

  return chunks;
}

async function saveChunkedContent(content, title, tags = [], metadata = {}) {
  // Derive a deterministic session ID from the conversation_id (title slug).
  // This ensures re-saves of the same conversation overwrite existing chunks
  // via the backend's ON CONFLICT (user_id, platform, conversation_id) upsert,
  // instead of creating duplicate chunk sets with random session IDs.
  const conversationId = metadata.conversationId || title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
  const sessionId = conversationId;
  const chunks = chunkContent(content);
  const totalParts = chunks.length;

  structuredLog.info('Saving chunked content', {
    session_id: sessionId,
    total_chars: content.length,
    total_parts: totalParts
  });

  const savedParts = [];

  // Save each chunk — uses deterministic conversation_id so re-saves upsert
  for (let i = 0; i < chunks.length; i++) {
    const partNumber = i + 1;
    const chunk = chunks[i];

    const partData = await makeApiCall('/api/v1/memories/', {
      method: 'POST',
      body: wafSafeBody({
        content: chunk,
        title: `${title} - Part ${partNumber}/${totalParts}`,
        tags: [...tags, 'chunked-conversation', `session:${sessionId}`],
        platform: PLATFORM,
        conversation_id: `${sessionId}:part:${partNumber}`,
        metadata: {
          ...metadata,
          captureType: 'chunked',
          sessionId,
          partNumber,
          totalParts,
          chunkSize: chunk.length,
          isComplete: false
        }
      })
    });

    const partMemoryId = partData.id || partData.memory_id;
    savedParts.push({ partNumber, memoryId: partMemoryId, size: chunk.length });

    structuredLog.debug('Chunk saved', {
      session_id: sessionId,
      part_number: partNumber,
      total_parts: totalParts,
      chunk_size: chunk.length,
      memory_id: partData.id || partData.memory_id
    });
  }

  // If re-chunk count decreased (e.g., content got shorter), orphaned parts
  // from previous saves remain but won't be linked. They'll be naturally
  // invisible since the index only references current parts.

  // Create index memory — also uses deterministic conversation_id for upsert
  const indexContent = `# ${title} - Complete Capture Index\n\n## Capture Summary\n- Total Parts: ${totalParts}\n- Total Size: ${content.length} characters\n- Session ID: ${sessionId}\n- Saved: ${new Date().toISOString()}\n\n## Parts Overview\n${savedParts.map(p => `- Part ${p.partNumber}: ${p.size} chars [${p.memoryId}]`).join('\n')}\n\n## Metadata\n${JSON.stringify(metadata, null, 2)}\n\n## Full Content Access\nUse recall_memories with session:${sessionId} to find all parts, or use get_memory_details with any part ID.`;

  const indexData = await makeApiCall('/api/v1/memories/', {
    method: 'POST',
    body: wafSafeBody({
      content: indexContent,
      title: `${title} - Index`,
      tags: [...tags, 'chunked-index', `session:${sessionId}`],
      platform: PLATFORM,
      conversation_id: `${sessionId}:index`,
      metadata: {
        ...metadata,
        captureType: 'chunked-index',
        sessionId,
        totalParts,
        totalSize: content.length,
        partIds: savedParts.map(p => p.memoryId),
        isComplete: true
      }
    })
  });

  structuredLog.info('Chunked content save complete', {
    session_id: sessionId,
    total_parts: totalParts,
    index_memory_id: indexData.id || indexData.memory_id
  });

  return {
    sessionId,
    totalParts,
    totalSize: content.length,
    indexId: indexData.id || indexData.memory_id,
    parts: savedParts
  };
}

async function saveSingleContent(content, title, tags = [], metadata = {}) {
  structuredLog.debug('Saving single content', {
    char_count: content.length,
    title
  });

  // Use POST /api/v1/memories/ with conversation_id for atomic ON CONFLICT upsert.
  // This is the single correct path — the backend handles:
  //   - Living document detection via ON CONFLICT (user_id, platform, conversation_id)
  //   - Tag preservation via Postgres array literal
  //   - embedding_status = 'pending' on both insert and update
  //   - processMemoryBackground() for embedding + intelligence extraction
  //   - Soft-delete revival (restores trashed memories on re-save)
  const sessionId = readCurrentSessionId();
  const payload: Record<string, unknown> = {
    content,
    title,
    tags: [...tags, 'complete-conversation'],
    platform: PLATFORM,
    conversation_id: metadata.conversationId || null,
    mode: metadata._mode || 'replace',
    metadata: {
      ...metadata,
      captureType: 'single',
      isComplete: true
    }
  };
  // Only include session_id if it's a real string (Zod rejects null)
  if (sessionId) payload.session_id = sessionId;

  const data = await makeApiCall('/api/v1/memories/', {
    method: 'POST',
    body: wafSafeBody(payload)
  });

  const memoryId = data.id || data.memory_id;
  const wasUpdated = data.updated === true;

  structuredLog.info('Single content saved', {
    memory_id: memoryId,
    char_count: content.length,
    was_update: wasUpdated
  });

  return {
    memoryId,
    size: content.length,
    wasUpdated,
    wisdomSuggestion: data.wisdom_suggestion || null
  };
}

// PHASE 16.3: Helper to format wisdom suggestions
function formatWisdomSuggestion(wisdomSuggestion) {
  if (!wisdomSuggestion) return '';

  const { tool, reason, confidence, url, best_for, context_prompt } = wisdomSuggestion;

  return `\n\n` +
    `🧠 WISDOM SUGGESTION (Phase 16.3):\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✨ Recommended Next Tool: ${tool.toUpperCase()}\n` +
    `📊 Confidence: ${(confidence * 100).toFixed(0)}%\n` +
    `💡 Why: ${reason}\n` +
    `🔗 URL: ${url}\n\n` +
    `📋 Best For: ${best_for.join(', ')}\n\n` +
    `💬 Ready-to-use prompt:\n` +
    `${context_prompt.split('\n').slice(0, 8).join('\n')}\n` +
    `   [...see full prompt in ${tool}]\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━���━\n` +
    `🎯 Click the URL above to continue your workflow in ${tool}!\n`;
}

// ============================================================================
// Tool handlers
// ============================================================================

export async function handleSaveConversation(args) {
  const toolName = 'save_conversation';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId
  });

  try {
    const rawContent = args.conversationContent || '';
    const content = sanitizeUnicode(rawContent);
    const contentLength = content.length;

    structuredLog.debug('Extracting intelligent context', {
      request_id: requestId,
      content_length: contentLength
    });

    const intelligentContext = extractProjectContext(content);

    let title = args.title;
    if (!title || title.startsWith('Conversation 202')) {
      title = generateIntelligentTitle(intelligentContext, content);
      structuredLog.debug('Generated intelligent title', {
        request_id: requestId,
        title
      });
    }

    const progressIndicators = extractProgressIndicators(content);
    const relationships = extractRelationships(content);

    // args.tags may arrive as a JSON string from some MCP transports — parse it
    let rawTags = args.tags;
    if (typeof rawTags === 'string') {
      try { rawTags = JSON.parse(rawTags); } catch { rawTags = [rawTags]; }
    }
    const tags: string[] = Array.isArray(rawTags) ? rawTags : (rawTags ? [String(rawTags)] : ['complete-conversation']);

    let conversationId = args.conversationId;
    if (!conversationId && title && !title.startsWith('Conversation 202')) {
      conversationId = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 100);

      structuredLog.debug('Generated conversation ID from title', {
        request_id: requestId,
        conversation_id: conversationId
      });
    }

    if (contentLength < 100) {
      structuredLog.warn('Insufficient content detected', {
        request_id: requestId,
        content_length: contentLength
      });

      return {
        content: [{
          type: 'text',
          text: `❌ INSUFFICIENT CONTENT DETECTED!\n\n` +
                `You provided only ${contentLength} characters.\n\n` +
                `This usually means the conversation is too long to inline into a single tool call.\n\n` +
                `SOLUTION — Write a rich summary instead:\n` +
                `Call save_conversation again with conversationContent set to a detailed summary (500+ chars) like:\n\n` +
                `=== CONVERSATION SUMMARY ===\n` +
                `Topic: [what this session was about]\n` +
                `Accomplished: [what was done]\n` +
                `Key decisions: [decisions made]\n` +
                `Code changes: [files changed + what changed]\n` +
                `Errors fixed: [bugs found and resolved]\n` +
                `Status: [done/in-progress/blocked]\n` +
                `Next steps: [what to do next]\n` +
                `=== END ===\n\n` +
                `The auto-capture hook will save the full transcript separately.\n` +
                `The summary ensures key decisions and context are searchable.`
        }]
      };
    }

    if (contentLength < 500 && !content.includes('USER:') && !content.includes('ASSISTANT:')) {
      structuredLog.warn('Possible summary detected', {
        request_id: requestId,
        content_length: contentLength
      });

      return {
        content: [{
          type: 'text',
          text: `⚠️ POSSIBLE SUMMARY DETECTED!\n\n` +
                `Content: "${content}"\n\n` +
                `This appears to be a summary rather than the full conversation.\n` +
                `Please include the complete conversation with:\n` +
                `- USER: [exact messages]\n` +
                `- ASSISTANT: [exact responses]\n` +
                `- All code blocks and artifacts\n\n` +
                `Or confirm this is the complete content by adding more context.`
        }]
      };
    }

    const metadata = extractContentMetadata(content);

    // Living document is now handled atomically by the backend's ON CONFLICT clause.
    // No need to search+PATCH — just POST with conversation_id and let PostgreSQL
    // decide whether to INSERT or UPDATE in a single atomic operation.

    metadata.conversationId = conversationId;

    metadata.intelligent = {
      ...intelligentContext,
      progress_indicators: progressIndicators,
      ...relationships
    };

    // Identity Layer: attach session context to new memories
    try {
      const sessionResp = await makeApiCall(`/api/v1/identity/session?platform=${encodeURIComponent(PLATFORM)}`);
      const sess = sessionResp.session || {};
      if (sess.id || sess.context || sess.project) {
        metadata.session_context = {
          session_id: sess.id,
          project: sess.project,
          context: sess.context,
          focus: sess.focus,
          platform: PLATFORM
        };
        structuredLog.debug('Attached session context to memory', { project: sess.project });
      }
    } catch (sessionErr) {
      // Non-fatal — save proceeds without session context
      structuredLog.warn('Could not fetch session context (non-fatal)', { error_message: sessionErr.message });
    }

    // Peek at next pending task for this project (read-only, no mutation)
    // Priority: explicit project_name arg > title prefix (e.g. "Purmemo - ...") > intelligentContext
    let nextTaskHint = null;
    const inferredProject = (
      args.project_name ||
      intelligentContext.project_name ||
      (title && title.split(/[\s\-–—]+/)[0].toLowerCase()) ||
      ''
    ).trim().toLowerCase();
    if (inferredProject) {
      try {
        const peekResp = await makeApiCall(`/api/v1/projects/${encodeURIComponent(inferredProject)}/pending_task`);
        if (peekResp.task) {
          nextTaskHint = peekResp.task;
        }
      } catch {
        // Non-fatal — save proceeds without task hint
      }
    }

    const nextTaskLine = nextTaskHint
      ? `\n\n⬇️  NEXT TASK: #${nextTaskHint.sequence} — ${nextTaskHint.title}\nCall get_next_task({ project_name: "${inferredProject}" }) to begin.`
      : '';

    if (shouldChunk(content)) {
      const result = await saveChunkedContent(content, title, tags, metadata);
      const isAutoGenerated = !args.conversationId && conversationId;

      structuredLog.info(`${toolName}: completed`, {
        tool_name: toolName,
        request_id: requestId,
        duration_ms: Date.now() - startTime,
        action: 'chunked',
        session_id: result.sessionId,
        total_parts: result.totalParts,
        char_count: result.totalSize
      });

      return {
        content: [{
          type: 'text',
          text: `✅ LARGE CONVERSATION SAVED (Auto-chunked)!\n\n` +
                (conversationId ? `📝 Conversation ID: ${conversationId}` + (isAutoGenerated ? ' (auto-generated from title)\n' : '\n') : '') +
                `📏 Total size: ${result.totalSize} characters\n` +
                `📦 Saved as: ${result.totalParts} linked parts\n` +
                `🔗 Session ID: ${result.sessionId}\n` +
                `📋 Index ID: ${result.indexId}\n\n` +
                `📊 Content Analysis:\n` +
                `- Conversation turns: ${metadata.conversationTurns}\n` +
                `- Code blocks: ${metadata.codeBlockCount}\n` +
                `- Artifacts: ${metadata.artifactCount}\n` +
                `- URLs: ${metadata.urlCount}\n` +
                `- File paths: ${metadata.filePathCount}\n\n` +
                (conversationId && isAutoGenerated ? `💡 Auto-living document: Next save with title "${title}" will UPDATE this memory\n` : '') +
                (conversationId && !isAutoGenerated ? `✓ Use conversation ID "${conversationId}" to update this later!\n` : '') +
                `✓ Complete conversation preserved with all context!` +
                (metadata.artifactCount > 0 && conversationId ? `\n\n📎 **${metadata.artifactCount} artifact(s) detected.** Use save_artifact to preserve each artifact separately with conversationId="${conversationId}".` : '') +
                nextTaskLine
        }]
      };
    } else {
      const result = await saveSingleContent(content, title, tags, metadata);
      const isAutoGenerated = !args.conversationId && conversationId;
      const action = result.wasUpdated ? 'updated' : 'created';

      structuredLog.info(`${toolName}: completed`, {
        tool_name: toolName,
        request_id: requestId,
        duration_ms: Date.now() - startTime,
        action,
        memory_id: result.memoryId,
        char_count: result.size
      });

      const savedOrUpdated = result.wasUpdated
        ? `✅ CONVERSATION UPDATED (Living Document)!\n\n` +
          (conversationId ? `📝 Conversation ID: ${conversationId}` + (isAutoGenerated ? ' (auto-generated from title)\n' : '\n') : '') +
          `📏 New size: ${result.size} characters\n` +
          `🔗 Memory ID: ${result.memoryId}\n\n` +
          `📊 Content Analysis:\n` +
          `- Conversation turns: ${metadata.conversationTurns}\n` +
          `- Code blocks: ${metadata.codeBlockCount}\n` +
          `- Artifacts: ${metadata.artifactCount}\n` +
          `- URLs: ${metadata.urlCount}\n\n` +
          (isAutoGenerated ? `💡 Auto-living document: Saves with title "${title}" will update this memory\n` : '') +
          `✓ Updated existing memory (not duplicated)!`
        : `✅ CONVERSATION SAVED!\n\n` +
          (conversationId ? `📝 Conversation ID: ${conversationId}` + (isAutoGenerated ? ' (auto-generated from title)\n' : '\n') : '') +
          `📏 Size: ${result.size} characters\n` +
          `🔗 Memory ID: ${result.memoryId}\n\n` +
          `📊 Content Analysis:\n` +
          `- Conversation turns: ${metadata.conversationTurns}\n` +
          `- Code blocks: ${metadata.codeBlockCount}\n` +
          `- Artifacts: ${metadata.artifactCount}\n` +
          `- URLs: ${metadata.urlCount}\n` +
          `- File paths: ${metadata.filePathCount}\n\n` +
          (conversationId && isAutoGenerated ? `💡 Auto-living document: Next save with title "${title}" will UPDATE this memory\n` : '') +
          (conversationId && !isAutoGenerated ? `✓ Use conversation ID "${conversationId}" to update this later!\n` : '') +
          `✓ Complete conversation preserved!` +
          (metadata.artifactCount > 0 && conversationId ? `\n\n📎 **${metadata.artifactCount} artifact(s) detected.** Use save_artifact to preserve each artifact separately with conversationId="${conversationId}".` : '');

      return {
        content: [{
          type: 'text',
          text: savedOrUpdated + formatWisdomSuggestion(result.wisdomSuggestion) + nextTaskLine
        }]
      };
    }

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });

    return {
      content: [{
        type: 'text',
        text: `❌ Save Error: ${errorMsg}\n\nPlease try again or contact support if the issue persists.`
      }]
    };
  }
}

// ADR-025: Save artifact as first-class object linked to a conversation
export async function handleSaveArtifact(args) {
  const toolName = 'save_artifact';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId
  });

  try {
    const parentConversationId = args.conversationId;
    const title = args.title;
    const artifactType = args.type;
    const rawContent = args.content || '';
    const content = sanitizeUnicode(rawContent);
    let rawArtifactTags = args.tags;
    if (typeof rawArtifactTags === 'string') {
      try { rawArtifactTags = JSON.parse(rawArtifactTags); } catch { rawArtifactTags = [rawArtifactTags]; }
    }
    const tags = [...(Array.isArray(rawArtifactTags) ? rawArtifactTags : []), 'artifact', artifactType];

    // Validate required fields
    if (!parentConversationId || !title || !artifactType || content.length < 100) {
      const missing = [];
      if (!parentConversationId) missing.push('conversationId');
      if (!title) missing.push('title');
      if (!artifactType) missing.push('type');
      if (content.length < 100) missing.push(`content (${content.length} chars, minimum 100)`);

      return {
        content: [{
          type: 'text',
          text: `❌ Missing or invalid fields: ${missing.join(', ')}\n\nAll fields (conversationId, title, type, content) are required. Content must be at least 100 characters.`
        }]
      };
    }

    // Generate deterministic conversation_id for the artifact
    const artifactSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
    const artifactConversationId = `${parentConversationId}:artifact:${artifactSlug}`;

    const sessionId = readCurrentSessionId();
    const payload = {
      content,
      title,
      tags,
      platform: PLATFORM,
      conversation_id: artifactConversationId,
      artifact_type: artifactType,
      parent_conversation_id: parentConversationId,
      metadata: {
        characterCount: content.length,
        wordCount: content.split(/\s+/).length,
        captureType: 'artifact',
        artifactType,
        parentConversationId,
        isComplete: true,
        conversationId: artifactConversationId,
      },
      ...(sessionId && { session_id: sessionId }),
    };

    const data = await makeApiCall('/api/v1/memories/', {
      method: 'POST',
      body: wafSafeBody(payload),
    });

    const memoryId = data.id || data.memory_id;
    const wasUpdated = data.updated === true;

    structuredLog.info(`${toolName}: completed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      memory_id: memoryId,
      artifact_type: artifactType,
      parent_conversation_id: parentConversationId,
      char_count: content.length,
    });

    const statusEmoji = wasUpdated ? '🔄' : '✅';
    const statusWord = wasUpdated ? 'UPDATED' : 'SAVED';

    return {
      content: [{
        type: 'text',
        text: `${statusEmoji} Artifact ${statusWord}!\n\n` +
          `📎 Title: ${title}\n` +
          `📦 Type: ${artifactType}\n` +
          `📏 Size: ${content.length.toLocaleString()} characters\n` +
          `🔗 Linked to: ${parentConversationId}\n` +
          `🆔 Memory ID: ${memoryId}\n\n` +
          `✓ Artifact preserved as first-class object linked to parent conversation.`
      }]
    };

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });

    return {
      content: [{
        type: 'text',
        text: `❌ Save Artifact Error: ${errorMsg}\n\nPlease try again or contact support if the issue persists.`
      }]
    };
  }
}

// ADR-032 / ADR-034: Commit a commitment-shaped artifact (PRD, ADR, spec, OKR).
// Thin write primitive — no conversation_id is sent (INSERT-only, no upsert
// collisions). Slash commands /prd, /decide, /spec, /commit call this.
export async function handleCommit(args) {
  const toolName = 'commit';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId
  });

  try {
    const title = args.title;
    const rawContent = args.content || '';
    const content = sanitizeUnicode(rawContent);
    const commitmentType = args.commitment_type;
    const keyResult = args.key_result;
    const targetDate = args.target_date;

    let rawTags = args.tags;
    if (typeof rawTags === 'string') {
      try { rawTags = JSON.parse(rawTags); } catch { rawTags = [rawTags]; }
    }
    const tags = [...(Array.isArray(rawTags) ? rawTags : []), 'commitment', commitmentType?.toLowerCase()].filter(Boolean);

    const VALID_TYPES = ['PRD', 'ADR', 'spec', 'OKR', 'other'];
    const missing = [];
    if (!title) missing.push('title');
    if (content.length < 100) missing.push(`content (${content.length} chars, minimum 100)`);
    if (!commitmentType) missing.push('commitment_type');
    else if (!VALID_TYPES.includes(commitmentType)) missing.push(`commitment_type (must be one of: ${VALID_TYPES.join(', ')})`);
    if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) missing.push('target_date (must be YYYY-MM-DD)');
    if (keyResult && keyResult.length > 2000) missing.push(`key_result (${keyResult.length} chars, max 2000)`);

    if (missing.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `❌ Missing or invalid fields: ${missing.join(', ')}\n\nRequired: title, content (≥100 chars), commitment_type (PRD|ADR|spec|OKR|other).\nOptional: key_result (≤2000 chars), target_date (YYYY-MM-DD), tags.`
        }]
      };
    }

    const sessionId = readCurrentSessionId();
    const payload = {
      title,
      content,
      tags,
      platform: PLATFORM,
      commitment_type: commitmentType,
      ...(keyResult && { key_result: keyResult }),
      ...(targetDate && { target_date: targetDate }),
      ...(sessionId && { session_id: sessionId }),
      // INSERT-only — no conversation_id (per ADR-034 v2). Repeat /decide
      // calls produce a new memory each time; supersede via recency.
    };

    const data = await makeApiCall('/api/v1/memories/', {
      method: 'POST',
      body: wafSafeBody(payload),
    });

    const memoryId = data.id || data.memory_id;

    structuredLog.info(`${toolName}: completed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      memory_id: memoryId,
      commitment_type: commitmentType,
      char_count: content.length,
    });

    return {
      content: [{
        type: 'text',
        text: `✅ Commitment SAVED!\n\n` +
          `📎 Title: ${title}\n` +
          `📦 Type: ${commitmentType}\n` +
          (keyResult ? `🎯 Key result: ${keyResult}\n` : '') +
          (targetDate ? `📅 Target date: ${targetDate}\n` : '') +
          `📏 Size: ${content.length.toLocaleString()} characters\n` +
          `🆔 Memory ID: ${memoryId}\n\n` +
          `✓ Queryable via GET /api/v1/commitments/?type=${commitmentType}`
      }]
    };

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });

    return {
      content: [{
        type: 'text',
        text: `❌ Commit Error: ${errorMsg}\n\nPlease try again or contact support if the issue persists.`
      }]
    };
  }
}

// ADR-032 / ADR-034: Snapshot a topic — generate a state-shaped artifact.
// Thin wrapper over POST /api/v1/snapshots/. The user-facing slash command
// /snapshot calls this. Returns the draft snapshot id; promotion to canonical
// is a separate explicit step (POST /:id/accept) per ADR-032 review trigger.
// ── snapshot_sources ─────────────────────────────────────────────────────────
// MCP path step 1 (ADR-032 Amendment A): fetch citation bundle + conflict
// detection results so Claude can synthesize in-context. No Gemini call.
export async function handleSnapshotSources(args) {
  const toolName = 'snapshot_sources';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, { tool_name: toolName, request_id: requestId });

  try {
    const topic = (args.topic || '').trim();
    if (!topic) {
      return { content: [{ type: 'text', text: '❌ Missing required field: topic' }] };
    }

    const data = await makeApiCall('/api/v1/snapshots/sources', {
      method: 'POST',
      body: JSON.stringify({ topic }),
      timeoutMs: 90000,
    });

    structuredLog.info(`${toolName}: complete`, {
      tool_name: toolName, request_id: requestId,
      duration_ms: Date.now() - startTime,
      source_count: data.sources?.length,
      evidence_tier: data.evidence_tier,
      conflict_count: data.conflicts?.length,
    });

    const sources = data.sources || [];
    const conflicts = data.conflicts || [];
    const uncertainPairs = data.uncertain_pairs || [];

    const sourceLines = sources.map((s, i) =>
      `### Source ${i + 1} — ${s.title || 'Untitled'}\n_id: ${s.id} · updated: ${s.content_updated_at?.slice(0, 10) || '?'} · tags: ${(s.tags || []).slice(0, 5).join(', ')}_\n\n${(s.content || '').slice(0, 3000)}${(s.content || '').length > 3000 ? '…' : ''}`
    ).join('\n\n---\n\n');

    const conflictSection = conflicts.length > 0
      ? `\n\n## Conflicts Detected (${conflicts.length})\n${conflicts.map(c => `- **${c.kind || 'conflict'}**: ${c.description || c.text || JSON.stringify(c)}`).join('\n')}`
      : '';

    const uncertainSection = uncertainPairs.length > 0
      ? `\n\n## Uncertain Pairs (${uncertainPairs.length})\n${uncertainPairs.map(p => `- ${p.description || JSON.stringify(p)}`).join('\n')}`
      : '';

    return {
      content: [{
        type: 'text',
        text: `# Snapshot Sources — ${topic}\n\n**Evidence tier:** ${data.evidence_tier} · **Sources:** ${sources.length} · **Conflicts:** ${conflicts.length}\n**Cited IDs:** ${data.cited_memory_ids?.join(', ')}\n\n_Synthesize these sources into a current-state document, then call save_snapshot(topic, content, cited_ids) to persist._\n\n${sourceLines}${conflictSection}${uncertainSection}`,
      }]
    };

  } catch (error) {
    structuredLog.error(`${toolName}: failed`, { tool_name: toolName, request_id: requestId, error_message: error.message });
    return { content: [{ type: 'text', text: `❌ snapshot_sources error: ${safeErrorMessage(error)}` }] };
  }
}

// ── save_snapshot ─────────────────────────────────────────────────────────────
// MCP path step 3 (ADR-032 Amendment A): persist Claude's synthesized content
// as a draft snapshot. Backend derives evidence_tier from cited_ids — not
// caller-controlled. Runs claim verifier on provided content.
export async function handleSaveSnapshot(args) {
  const toolName = 'save_snapshot';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, { tool_name: toolName, request_id: requestId });

  try {
    const topic = (args.topic || '').trim();
    const content = (args.content || '').trim();
    const citedIds = args.cited_ids || [];

    if (!topic) return { content: [{ type: 'text', text: '❌ Missing required field: topic' }] };
    if (content.length < 100) return { content: [{ type: 'text', text: '❌ content too short (min 100 chars)' }] };
    if (citedIds.length === 0) return { content: [{ type: 'text', text: '❌ cited_ids required — pass the IDs from snapshot_sources' }] };

    const data = await makeApiCall('/api/v1/snapshots/', {
      method: 'POST',
      body: JSON.stringify({ topic, content, cited_ids: citedIds, force: args.force || false }),
    });

    structuredLog.info(`${toolName}: complete`, {
      tool_name: toolName, request_id: requestId,
      duration_ms: Date.now() - startTime,
      snapshot_id: data.id,
      version: data.version,
    });

    if (data.regeneration_skipped) {
      return { content: [{ type: 'text', text: `ℹ️ No source memories changed since last canonical — snapshot not regenerated.\n\nPass force: true to override.\n\nExisting canonical ID: ${data.id}` }] };
    }

    return {
      content: [{
        type: 'text',
        text: `✅ Snapshot DRAFTED!\n\n📎 Topic: ${data.topic}\n🔖 Version: ${data.version}\n📊 Evidence tier: ${data.evidenceTier ?? data.evidence_tier}\n📏 Grounded ratio: ${typeof data.groundedRatio === 'number' ? data.groundedRatio.toFixed(2) : (data.grounded_ratio ?? '—')}\n🔗 Cited memories: ${data.cited_memory_count ?? citedIds.length}\n🆔 Snapshot ID: ${data.id}\n📝 Status: draft\n🤖 Generator: caller-provided (Claude)\n\nNext: call accept_snapshot(id: "${data.id}") to promote to canonical.`
      }]
    };

  } catch (error) {
    structuredLog.error(`${toolName}: failed`, { tool_name: toolName, request_id: requestId, error_message: error.message });
    return { content: [{ type: 'text', text: `❌ save_snapshot error: ${safeErrorMessage(error)}` }] };
  }
}

// ── accept_snapshot ───────────────────────────────────────────────────────────
// Promote a draft snapshot to canonical. Surfaces gate_blockers on 409 so
// Claude can present them to the user. Supports force:true for override.
export async function handleAcceptSnapshot(args) {
  const toolName = 'accept_snapshot';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, { tool_name: toolName, request_id: requestId });

  // Declare outside try so catch can reference it in gate blocker message
  const snapshotId = (args.snapshot_id || '').trim();
  if (!snapshotId) return { content: [{ type: 'text', text: '❌ Missing required field: snapshot_id' }] };

  try {
    const data = await makeApiCall(`/api/v1/snapshots/${snapshotId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ force: args.force || false }),
    });

    structuredLog.info(`${toolName}: complete`, { tool_name: toolName, request_id: requestId, duration_ms: Date.now() - startTime });

    return {
      content: [{
        type: 'text',
        text: `✅ Snapshot PROMOTED to canonical!\n\n🆔 ID: ${data.promoted?.id}\n📎 Topic: ${data.promoted?.topic}\n🔖 Version: ${data.promoted?.version}\n${data.superseded_id ? `🔁 Superseded: ${data.superseded_id}` : ''}\n${data.approved_with_overrides?.length ? `⚠️ Approved with overrides: ${data.approved_with_overrides.join(', ')}` : ''}`
      }]
    };

  } catch (error) {
    // 409 gate blocker — parse raw error.message before safeErrorMessage flattens it
    const msg = error.message || '';
    if (msg.includes('API Error 409')) {
      try {
        const bodyMatch = msg.match(/API Error 409:\s*(.+)$/s);
        if (bodyMatch) {
          const parsed = JSON.parse(bodyMatch[1]);
          const blockers = (parsed.gate_blockers || [])
            .map(b => `- **${b.code}**: ${b.detail}`)
            .join('\n');
          const hint = parsed.hint || `Call accept_snapshot(snapshot_id: "${snapshotId}", force: true) to approve and promote anyway.`;
          return {
            content: [{
              type: 'text',
              text: `⚠️ Snapshot requires review before promotion:\n\n${blockers || '(no blockers listed)'}\n\n${hint}`
            }]
          };
        }
      } catch { /* fall through to generic error */ }
    }
    structuredLog.error(`${toolName}: failed`, { tool_name: toolName, request_id: requestId, error_message: error.message });
    return { content: [{ type: 'text', text: `❌ accept_snapshot error: ${safeErrorMessage(error)}` }] };
  }
}

export async function handleGetSnapshot(args) {
  const toolName = 'get_snapshot';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  structuredLog.info(`${toolName}: starting`, { tool_name: toolName, request_id: requestId });

  try {
    const topic = (args.topic || '').trim();
    const snapshotId = (args.snapshot_id || '').trim();

    if (!topic && !snapshotId) {
      return {
        content: [{
          type: 'text',
          text: `❌ Provide either topic or snapshot_id.\n\nExamples:\n- get_snapshot(topic: "architecture") — fetches canonical snapshot\n- get_snapshot(snapshot_id: "uuid") — fetches specific snapshot`
        }]
      };
    }

    let data;
    if (snapshotId) {
      data = await makeApiCall(`/api/v1/snapshots/${snapshotId}`, { method: 'GET' });
    } else {
      // Fetch canonical snapshot for topic
      const params = new URLSearchParams({ topic, status: 'canonical', page_size: '1' });
      const list = await makeApiCall(`/api/v1/snapshots/?${params}`, { method: 'GET' });
      const snapshots = list.snapshots || [];
      if (snapshots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No canonical snapshot found for topic "${topic}".\n\nRun snapshot(topic: "${topic}") to generate one, then accept it to promote to canonical.`
          }]
        };
      }
      // Fetch full content of the canonical
      data = await makeApiCall(`/api/v1/snapshots/${snapshots[0].id}`, { method: 'GET' });
    }

    structuredLog.info(`${toolName}: complete`, { tool_name: toolName, request_id: requestId, snapshot_id: data.id });

    const tier = data.evidence_tier ?? data.evidenceTier ?? '?';
    const version = data.version ?? '?';
    const status = data.status ?? '?';
    const topic_out = data.topic ?? topic;
    const grounded = typeof data.grounded_ratio === 'number' ? data.grounded_ratio.toFixed(2) : '—';
    const conflicts = Array.isArray(data.conflicts_detected) ? data.conflicts_detected.length : 0;

    const header = [
      `# Snapshot — ${topic_out}`,
      `**Version:** ${version} · **Status:** ${status} · **Tier:** ${tier} · **Grounded:** ${grounded} · **Conflicts:** ${conflicts}`,
      `**ID:** ${data.id}`,
      ``,
    ].join('\n');

    return {
      content: [{
        type: 'text',
        text: header + (data.content || '(no content)'),
      }]
    };

  } catch (error) {
    structuredLog.error(`${toolName}: failed`, { tool_name: toolName, request_id: requestId, error_message: error.message });
    return {
      content: [{
        type: 'text',
        text: `❌ get_snapshot error: ${safeErrorMessage(error)}`
      }]
    };
  }
}

export async function handleSnapshot(args) {
  const toolName = 'snapshot';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId
  });

  try {
    const topic = (args.topic || '').trim();

    if (!topic) {
      return {
        content: [{
          type: 'text',
          text: `❌ Missing required field: topic\n\nUsage: snapshot(topic: "architecture")`
        }]
      };
    }
    if (topic.length > 200) {
      return {
        content: [{
          type: 'text',
          text: `❌ Topic too long (${topic.length} chars, max 200)`
        }]
      };
    }

    const data = await makeApiCall('/api/v1/snapshots/', {
      method: 'POST',
      body: JSON.stringify({ topic }),
      timeoutMs: 60000,
    });

    structuredLog.info(`${toolName}: completed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      snapshot_id: data.id,
      topic,
      version: data.version,
      evidence_tier: data.evidenceTier ?? data.evidence_tier,
    });

    const tier = data.evidenceTier ?? data.evidence_tier ?? '?';
    const grounded = data.groundedRatio ?? data.grounded_ratio;
    const groundedStr = typeof grounded === 'number' ? grounded.toFixed(2) : '—';
    const cited = data.cited_memory_count ?? '?';

    return {
      content: [{
        type: 'text',
        text: `✅ Snapshot DRAFTED!\n\n` +
          `📎 Topic: ${topic}\n` +
          `🔖 Version: ${data.version}\n` +
          `📊 Evidence tier: ${tier}\n` +
          `📏 Grounded ratio: ${groundedStr}\n` +
          `🔗 Cited memories: ${cited}\n` +
          `🆔 Snapshot ID: ${data.id}\n` +
          `📝 Status: draft (review and explicitly accept to promote to canonical)\n\n` +
          `${data.tier_reason ? `_${data.tier_reason}_\n\n` : ''}` +
          `Next: review the snapshot content, then POST /api/v1/snapshots/${data.id}/accept to promote.`
      }]
    };

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });

    return {
      content: [{
        type: 'text',
        text: `❌ Snapshot Error: ${errorMsg}\n\nIf no source memories matched the topic, try a different keyword or save more relevant memories first.`
      }]
    };
  }
}

export async function handleDiscoverRelated(args) {
  const toolName = 'discover_related_conversations';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId
  });

  try {
    const safeQuery = sanitizeUnicode(args.query || '');

    const data = await makeApiCall(`/api/v10/mcp/tools/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tool: 'discover_related_conversations',
        arguments: {
          query: args.query,
          limit: parseInt(args.limit) || 10,
          relatedPerMemory: parseInt(args.relatedPerMemory) || 5
        }
      })
    });

    if (!data.content || !data.content[0] || !data.content[0].text) {
      structuredLog.warn(`${toolName}: no results found`, {
        tool_name: toolName,
        request_id: requestId,
        query: safeQuery
      });

      return {
        content: [{
          type: 'text',
          text: `🔍 No related conversations found for "${safeQuery}"\n\nTry different keywords or check if conversations were saved successfully.`
        }]
      };
    }

    const responseText = data.content[0].text;
    const finalSanitizedText = sanitizeUnicode(responseText);

    structuredLog.info(`${toolName}: completed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      response_size: finalSanitizedText.length
    });

    return {
      content: [{ type: 'text', text: finalSanitizedText }]
    };

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });

    if (error.message && error.message.includes('429')) {
      return {
        content: [{
          type: 'text',
          text: `⚠️ Monthly recall quota exceeded.\n\n${errorMsg}\n\nNote: 'discover_related_conversations' shares the same quota pool as 'recall_memories'.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Discovery Error: ${errorMsg}\n\nThis could be due to:\n- Monthly quota limit reached (check with your API provider)\n- Network connectivity issues\n- API endpoint changes\n\nTry using 'recall_memories' for basic search, or upgrade to PRO for unlimited recalls.`
      }]
    };
  }
}

// ── Local-first recall via purmemoAMP (localhost:7832) ──────────────────────
async function tryLocalRecall(query, limit = 5) {
  try {
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    const resp = await fetch(`http://localhost:7832/search?q=${encoded}&limit=${limit}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.results || data.results.length === 0) return null;
    return data.results;
  } catch {
    return null; // AMP not running or timeout — fall through to cloud
  }
}

export async function handleRecallMemories(args) {
  const toolName = 'recall_memories';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId
  });

  try {
    const safeQuery = sanitizeUnicode(args.query || '');

    // ── Local-first: try purmemoAMP before cloud ──
    const localResults = await tryLocalRecall(safeQuery, parseInt(args.limit) || 10);
    let localSection = '';
    if (localResults && localResults.length > 0) {
      localSection = `📍 **Local Sessions** (from purmemoAMP — ${localResults.length} found)\n\n`;
      localResults.forEach((r, i) => {
        // Truncate title — AMP may return AI extraction prompt as title for untitled sessions
        const rawTitle = r.title || '';
        const title = rawTitle.length > 80 ? rawTitle.slice(0, 80) + '…' : (rawTitle || 'Untitled');
        const project = r.project ? ` (${r.project})` : '';
        const snippet = r.snippet ? `\n   📝 ${r.snippet.slice(0, 200)}` : '';
        localSection += `${i + 1}. 💻 **${title}**${project}${snippet}\n`;
        localSection += `   🔗 Session: ${r.session_id}\n\n`;
      });
      localSection += `${'─'.repeat(40)}\n\n`;

      structuredLog.info(`${toolName}: local results`, {
        tool_name: toolName,
        request_id: requestId,
        local_count: localResults.length,
        duration_ms: Date.now() - startTime,
      });
    }

    const data = await makeApiCall(`/api/v10/mcp/tools/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tool: 'recall_memories',
        arguments: {
          query: args.query,
          limit: parseInt(args.limit) || 10,
          entity: args.entity,
          initiative: args.initiative,
          stakeholder: args.stakeholder,
          deadline: args.deadline,
          intent: args.intent,
          has_observations: args.has_observations
        }
      })
    });

    if (!data.content || !data.content[0] || !data.content[0].text) {
      structuredLog.warn(`${toolName}: no results found`, {
        tool_name: toolName,
        request_id: requestId,
        query: safeQuery
      });

      // Cloud found nothing — but local might have results
      if (localSection) {
        return {
          content: [{
            type: 'text',
            text: localSection + `\n☁️ No cloud memories found for "${safeQuery}" — showing local results only.`
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: `🔍 No memories found for "${safeQuery}"\n\nTry different keywords or check if the conversation was saved successfully.`
        }]
      };
    }

    const responseText = data.content[0].text;

    const memoryBlocks = responseText.split('\n\n').filter(block => block.includes('**') && (block.includes('ID:') || block.includes('Memory ID') || block.includes('memory_id') || /[0-9a-f]{8}-[0-9a-f]{4}/.test(block)));

    if (memoryBlocks.length === 0) {
      // DEBUG: log what the API actually returned so we can understand the format
      structuredLog.warn(`${toolName}: fallback triggered — memoryBlocks=0`, {
        tool_name: toolName,
        request_id: requestId,
        response_length: responseText.length,
        response_preview: responseText.slice(0, 500),
        duration_ms: Date.now() - startTime,
      });

      structuredLog.info(`${toolName}: completed`, {
        tool_name: toolName,
        request_id: requestId,
        duration_ms: Date.now() - startTime,
        results_count: 0
      });

      // Truncate raw response to prevent token overflow (API format may not match expected pattern)
      const MAX_RAW_CHARS = 8000;
      const truncated = responseText.length > MAX_RAW_CHARS
        ? sanitizeUnicode(responseText.slice(0, MAX_RAW_CHARS)) + `\n\n[... truncated ${responseText.length - MAX_RAW_CHARS} chars — use get_memory_details for full content]`
        : sanitizeUnicode(responseText);

      return {
        content: [{ type: 'text', text: truncated }]
      };
    }

    let resultText = `🔍 Found ${memoryBlocks.length} memories for "${safeQuery}" (ranked by relevance)\n\n`;

    // Cache IDs for ordinal resolution in get_memory_details
    const recalledIds = [];

    memoryBlocks.forEach((block, index) => {
      const titleMatch = block.match(/\*\*(.+?)\*\*/);
      const relevanceMatch = block.match(/Relevance Score: ([\d.]+)/) || block.match(/Relevance: ([\d.]+)%/);
      const idMatch = block.match(/ID: (.+)/);
      const platformMatch = block.match(/Platform: (\w+)/);
      const previewMatch = block.match(/Preview: (.+)/);

      const title = titleMatch ? titleMatch[1] : 'Untitled';
      const relevance = relevanceMatch ? relevanceMatch[1] : '?';
      const memoryId = idMatch ? idMatch[1].trim() : 'unknown';
      const platform = platformMatch ? platformMatch[1] : 'unknown';
      const preview = previewMatch ? previewMatch[1] : '';

      if (memoryId !== 'unknown') recalledIds.push(memoryId);

      const imageMatch = block.match(/📷\s*(\d+)\s*image/);
      const hasImage = block.includes('📷');
      const imageCount = imageMatch ? parseInt(imageMatch[1], 10) : (hasImage ? 1 : 0);

      const emoji = platform === 'chatgpt' ? '🤖' :
                     platform === 'claude' ? '🟣' :
                     platform === 'gemini' ? '💎' : '❓';

      resultText += `${index + 1}. ${emoji} **${sanitizeUnicode(title)}**\n`;
      resultText += `   🎯 Relevance: ${relevance}%\n`;
      resultText += `   🌍 Platform: ${platform}\n`;

      if (preview) {
        resultText += `   📝 Preview: ${sanitizeUnicode(preview.substring(0, 150))}...\n`;
      }
      if (imageCount > 0) {
        resultText += `   📷 ${imageCount} image${imageCount > 1 ? 's' : ''} — use get_memory_details to view\n`;
      }
      resultText += `   🔗 ID: ${memoryId}\n\n`;
    });

    // Update last recall cache for ordinal lookups
    _setLastRecallIds(recalledIds);

    // Preserve active todos section from API response (appended after memories)
    const todosMatch = responseText.match(/---\n\*\*Active Todos[\s\S]*/);
    if (todosMatch) {
      resultText += todosMatch[0] + '\n\n';
    }

    resultText += `${'─'.repeat(60)}\n\n`;
    resultText += `💡 **Discover More:**\n`;
    resultText += `Use 'discover_related_conversations' with your query to find related\n`;
    resultText += `conversations across ALL platforms (ChatGPT, Claude, Gemini).\n`;
    resultText += `Automatically grouped by AI-organized semantic clusters!\n`;

    // Prepend local results if available
    const finalSanitizedText = sanitizeUnicode(localSection + resultText);

    structuredLog.info(`${toolName}: completed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      results_count: memoryBlocks.length,
      response_size: finalSanitizedText.length
    });

    return {
      content: [{ type: 'text', text: finalSanitizedText }]
    };

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });

    return {
      content: [{
        type: 'text',
        text: `❌ Recall Error: ${errorMsg}`
      }]
    };
  }
}

export async function handleGetMemoryDetails(args) {
  const toolName = 'get_memory_details';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  // Resolve ordinal IDs ("1", "2", etc.) to UUIDs from last recall_memories result
  let resolvedId = args.memoryId;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(resolvedId)) {
    const currentIds = _getLastRecallIds();
    const ordinal = parseInt(resolvedId, 10);
    if (ordinal >= 1 && ordinal <= currentIds.length) {
      resolvedId = currentIds[ordinal - 1];
      structuredLog.info(`${toolName}: resolved ordinal ${args.memoryId} → ${resolvedId}`, {
        tool_name: toolName,
        request_id: requestId,
        original_id: args.memoryId,
        resolved_id: resolvedId
      });
    } else {
      const hint = currentIds.length > 0
        ? `Valid range: 1-${currentIds.length} (from last recall), or use a full UUID.`
        : 'Run recall_memories first to enable ordinal lookups, or use a full UUID.';
      return {
        content: [{
          type: 'text',
          text: `❌ Invalid memory ID: "${args.memoryId}"\n\n${hint}\n\nMemory IDs are UUIDs like: 951be873-8364-400a-8075-50e8650b67a9`
        }]
      };
    }
  }

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId,
    memory_id: resolvedId,
    original_id: args.memoryId !== resolvedId ? args.memoryId : undefined,
    include_linked_parts: args.includeLinkedParts
  });

  // ── Try AMP for local session details (non-blocking, enrichment only) ──
  let localDetails = '';
  try {
    const synopsisResp = await fetch(`http://localhost:7832/sessions/${resolvedId}/synopsis`, {
      signal: AbortSignal.timeout(2000),
    });
    if (synopsisResp.ok) {
      const synopsisData = await synopsisResp.json();
      if (synopsisData.synopsis) {
        localDetails = `📍 **Local Session Details** (from purmemoAMP)\n\n${synopsisData.synopsis}\n\n${'─'.repeat(40)}\n\n`;
      }
    }
  } catch { /* AMP not running — continue to cloud */ }

  try {
    const data = await makeApiCall(`/api/v10/mcp/tools/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tool: 'get_memory_details',
        arguments: {
          memoryId: resolvedId,
          includeLinkedParts: args.includeLinkedParts !== false,
          ...(args.offset != null ? { offset: args.offset } : {}),
          ...(args.maxChars != null ? { maxChars: args.maxChars } : {}),
        }
      })
    });

    if (!data.content || !data.content[0]) {
      structuredLog.warn(`${toolName}: no content in response`, {
        tool_name: toolName,
        request_id: requestId,
        memory_id: resolvedId
      });

      return {
        content: [{
          type: 'text',
          text: `❌ Memory not found or invalid response\n\nMemory ID: ${resolvedId}`
        }]
      };
    }

    // Pass through all content blocks (text + image) from API
    const contentBlocks = data.content.map((block: any) => {
      if (block.type === 'image') {
        return { type: 'image', data: block.data, mimeType: block.mimeType };
      }
      // Prepend local details to first text block if available
      return { type: 'text', text: sanitizeUnicode(block.text || '') };
    });

    // Prepend local session details if available
    if (localDetails && contentBlocks.length > 0) {
      contentBlocks.unshift({ type: 'text', text: localDetails });
    }

    structuredLog.info(`${toolName}: completed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      memory_id: resolvedId,
      content_blocks: contentBlocks.length,
      has_local: !!localDetails,
      has_image: contentBlocks.some((b: any) => b.type === 'image')
    });

    return { content: contentBlocks };

  } catch (error) {
    const errorMsg = safeErrorMessage(error);

    structuredLog.error(`${toolName}: failed`, {
      tool_name: toolName,
      request_id: requestId,
      duration_ms: Date.now() - startTime,
      memory_id: resolvedId,
      error_message: error.message,
      error_type: error.constructor.name
    });

    // Cloud failed — return local details if we have them
    if (localDetails) {
      return {
        content: [{
          type: 'text',
          text: localDetails + `\n⚠️ Cloud lookup failed: ${errorMsg}\nShowing local data only.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Error retrieving memory: ${errorMsg}\n\nMemory ID: ${resolvedId}\n\nCheck logs for full details.`
      }]
    };
  }
}

// ============================================================================
// IDENTITY LAYER HANDLERS
// ============================================================================

export async function handleGetUserContext(args) {
  structuredLog.info('get_user_context: called', { platform: PLATFORM });

  try {
    // Fetch identity, session context, and recent memories in parallel
    const [identityResponse, sessionResponse, recentResponse] = await Promise.allSettled([
      makeApiCall('/api/v1/auth/me'),
      makeApiCall('/api/v1/identity/session'),
      makeApiCall('/api/v1/memories/?limit=20&sort=created_at&order=desc&include_source_types=desktop_clipboard,manual,chrome_extension', { method: 'GET' })
    ]);

    // Extract identity from /me response
    let identity = {};
    let userEmail = null;
    if (identityResponse.status === 'fulfilled') {
      const me = identityResponse.value;
      identity = me.identity || {};
      userEmail = me.email;
      structuredLog.debug('Identity loaded', { email: userEmail });
    } else {
      structuredLog.warn('Identity fetch failed', { error_message: String(identityResponse.reason) });
    }

    // Extract session context
    let session = {};
    if (sessionResponse.status === 'fulfilled') {
      session = sessionResponse.value.session || {};
      structuredLog.debug('Session loaded', { project: session.project, context: session.context });
    } else {
      structuredLog.warn('Session fetch failed', { error_message: String(sessionResponse.reason) });
    }

    // Build memory summary — frequency-weighted across 20 recent memories
    // Projects with ≥2 occurrences are genuinely active; single saves are noise
    let memorySummary = null;
    if (recentResponse.status === 'fulfilled') {
      const data = recentResponse.value;
      const memories = Array.isArray(data) ? data : (data.memories || []);
      if (memories.length > 0) {
        const projectCounts = {};
        const projectLatestTitle = {};
        for (const m of memories) {
          const proj = (m.project_name || '').trim();
          const title = (m.title || '').trim();
          if (!proj || !title) continue;
          projectCounts[proj] = (projectCounts[proj] || 0) + 1;
          if (!projectLatestTitle[proj]) projectLatestTitle[proj] = title;
        }
        // Only projects appearing ≥2 times, sorted by count desc
        const ranked = Object.entries(projectCounts)
          .filter(([, count]) => count >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        if (ranked.length > 0) {
          const parts = ranked.map(([proj]) => {
            const latest = projectLatestTitle[proj] || '';
            return latest ? `${proj} — ${latest}` : proj;
          });
          memorySummary = 'Recently working on: ' + parts.join('; ') + '.';
        }
        structuredLog.debug('Recent memories loaded', { count: memories.length, ranked_projects: ranked.length });
      }
    } else {
      structuredLog.warn('Recent memories fetch failed', { error_message: String(recentResponse.reason) });
    }

    // Build output text
    const hasIdentity = identity.role || (identity.expertise && identity.expertise.length > 0);
    const hasSession = session.context || session.project || session.focus;

    let output = `🧠 User Context for ${userEmail || 'this user'}\n\n`;

    output += `👤 Identity Profile\n`;
    if (identity.role) output += `   Role: ${identity.role}\n`;
    if (identity.primary_domain) output += `   Domain: ${identity.primary_domain}\n`;
    if (identity.work_style) output += `   Work style: ${identity.work_style}\n`;
    if (identity.expertise && identity.expertise.length > 0) {
      output += `   Expertise: ${identity.expertise.join(', ')}\n`;
    }
    if (identity.tools && identity.tools.length > 0) {
      output += `   Tools: ${identity.tools.join(', ')}\n`;
    }
    if (!hasIdentity) {
      output += `   (No identity profile set — user can configure at app.purmemo.ai/dashboard)\n`;
    }

    const autoTag = session.auto ? ' • auto' : '';
    output += `\n🎯 Current Session (${PLATFORM}${autoTag})\n`;
    if (session.project) output += `   Project: ${session.project}\n`;
    if (session.context) output += `   Working on: ${session.context}\n`;
    if (session.focus) output += `   Focus: ${session.focus}\n`;
    if (session.updated_at) output += `   Last updated: ${session.updated_at}\n`;
    if (!hasSession) {
      output += `   (No active session context — user can set "What are you working on?" in the dashboard)\n`;
    }

    output += `\n📚 Recent Memory Themes\n`;
    if (memorySummary) {
      output += `   ${memorySummary}\n`;
    } else {
      output += `   (No recent memories found)\n`;
    }

    output += `\n💡 How to use this context:\n`;
    output += `   - Address the user by their role and domain (not generically)\n`;
    output += `   - Assume their current project context without them having to repeat it\n`;
    output += `   - Tailor your responses to their expertise level and work style\n`;
    output += `   - Ask targeted follow-ups based on their focus area\n`;

    return {
      content: [{ type: 'text', text: output }]
    };

  } catch (error) {
    structuredLog.error('get_user_context: failed', { error_message: error.message });
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to load user context: ${error.message}\n\nMake sure your Purmemo API key is configured.`
      }]
    };
  }
}

// ============================================================================
// WORKFLOW ENGINE HANDLERS
// ============================================================================

export async function handleRunWorkflow(args) {
  const toolName = 'run_workflow';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId,
    workflow: args.workflow || 'auto-route',
    input_length: (args.input || '').length
  });

  try {
    const input = sanitizeUnicode(args.input || '');

    // Resolve which workflow to run
    let workflowName = args.workflow;
    let routeChain = [];
    let routeConfidence = 'direct';

    if (!workflowName) {
      // Auto-route from input
      const classified = classifyWorkflowIntent(input);
      workflowName = classified.workflow;
      routeChain = classified.chain;
      routeConfidence = classified.confidence;

      structuredLog.info(`${toolName}: auto-routed`, {
        request_id: requestId,
        routed_to: workflowName,
        confidence: routeConfidence
      });
    }

    // Resolve template: check hardcoded first, then database for user-created workflows
    let template = workflowName ? WORKFLOW_TEMPLATES[workflowName] : null;

    if (!workflowName) {
      // Could not route — return the catalog
      const catalogLines = Object.values(WORKFLOW_TEMPLATES)
        .map(wf => `  ${wf.name.padEnd(12)} — ${wf.description}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `I couldn't determine which workflow to run from your input.\n\n` +
                `📋 Available workflows:\n${catalogLines}\n\n` +
                `Try again with a specific workflow name, or describe your goal more specifically.\n` +
                `Example: run_workflow(workflow="prd", input="auth feature")`
        }]
      };
    }

    // If workflow not in hardcoded templates, it might be a user-created workflow
    // Check the database for it
    if (!template) {
      try {
        const userConfig = await makeApiCall(`/api/v1/workflow-dashboard/${workflowName}/user-config`);
        if (userConfig?.has_custom && userConfig?.prompt) {
          template = {
            name: workflowName,
            display_name: workflowName,
            description: '',
            memory_queries: ['[INPUT]'],
            route_chain: [],
            prompt: userConfig.prompt
          };
          structuredLog.info(`${toolName}: using user-created workflow`, {
            request_id: requestId,
            workflow: workflowName
          });
        }
      } catch {
        // Database unavailable — workflow not found
      }
    }

    if (!template) {
      return {
        content: [{
          type: 'text',
          text: `Unknown workflow: "${workflowName}". Use list_workflows to see available options.`
        }]
      };
    }

    // Check if the user has a custom prompt for this workflow (edits from dashboard)
    // User's custom prompt always wins over hardcoded default
    let workflowPrompt = template.prompt;
    try {
      const userConfig = await makeApiCall(`/api/v1/workflow-dashboard/${workflowName}/user-config`);
      if (userConfig?.has_custom && userConfig?.prompt) {
        workflowPrompt = userConfig.prompt;
        structuredLog.info(`${toolName}: using user's custom prompt`, {
          request_id: requestId,
          workflow: workflowName
        });
      }
    } catch {
      // Database unavailable — use hardcoded default
    }

    // Pre-load memories, identity, and (for kickoff) active todos in parallel
    const memoryQueries = buildMemoryQueries(template, input);

    const parallelCalls = [
      // [0] Identity
      (async () => {
        try {
          const [meResponse, sessionResponse] = await Promise.allSettled([
            makeApiCall('/api/v1/auth/me'),
            makeApiCall('/api/v1/identity/session')
          ]);
          const me = meResponse.status === 'fulfilled' ? meResponse.value : {};
          const session = sessionResponse.status === 'fulfilled' ? sessionResponse.value : {};
          const identity = me.identity || {};
          return {
            email: me.email || 'unknown',
            role: identity.role || '',
            expertise: (identity.expertise || []).join(', '),
            domain: identity.primary_domain || '',
            project: (session.session || {}).project || '',
            focus: (session.session || {}).focus || ''
          };
        } catch { return null; }
      })(),
      // [1..N] Memories (one call per query)
      ...memoryQueries.map(async (query) => {
        try {
          const data = await makeApiCall('/api/v10/mcp/tools/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tool: 'recall_memories',
              arguments: { query, limit: 3 }
            })
          });
          if (data.content && data.content[0] && data.content[0].text) {
            // Trim each memory result to prevent context overflow
            return data.content[0].text.substring(0, 1500);
          }
          return null;
        } catch { return null; }
      })
    ];

    // Pre-load active todos for kickoff workflow (or any workflow with preloadTodos)
    if (template.preloadTodos) {
      parallelCalls.push(
        (async () => {
          try {
            const data = await makeApiCall('/api/v1/todos/', { method: 'GET' });
            const todos = data.todos || [];
            if (todos.length === 0) return null;
            // Format as a readable block for the LLM
            const lines = todos.map((t, i) => {
              const status = t.status === 'blocked' ? '🔴' : t.status === 'active' ? '🟢' : '⚪';
              const project = t.project_name ? ` [${t.project_name}]` : '';
              const priority = t.priority ? ` (${t.priority})` : '';
              return `${i + 1}. ${status} ${t.text}${project}${priority}`;
            });
            return `## 📋 Active Todos (${todos.length})\n${lines.join('\n')}`;
          } catch { return null; }
        })()
      );
    }

    const allResults = await Promise.allSettled(parallelCalls);
    const identityResult = allResults[0];
    const memoryResults = allResults.slice(1, 1 + memoryQueries.length);
    const todosResult = template.preloadTodos ? allResults[allResults.length - 1] : null;

    // Assemble the identity context
    let identityBlock = '';
    if (identityResult.status === 'fulfilled' && identityResult.value) {
      const id = identityResult.value;
      const parts = [];
      if (id.role) parts.push(`Role: ${id.role}`);
      if (id.expertise) parts.push(`Expertise: ${id.expertise}`);
      if (id.domain) parts.push(`Domain: ${id.domain}`);
      if (id.project) parts.push(`Current project: ${id.project}`);
      if (id.focus) parts.push(`Current focus: ${id.focus}`);
      if (parts.length > 0) {
        identityBlock = `## Your Context (User Identity)\n${parts.join('\n')}\n`;
      }
    }

    // Assemble the memory context with transparency
    const memoryTexts = memoryResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    // Build transparency block — shows users exactly what memories are being used
    let transparencyBlock = '';
    if (memoryTexts.length > 0) {
      transparencyBlock = `## ⚡ Memories Powering This Workflow\n`;
      transparencyBlock += `The following memories were automatically pre-loaded from your vault to personalize this workflow.\n`;
      transparencyBlock += `Review them before reading the output — if any are outdated or irrelevant, tell the AI to disregard them.\n\n`;
      transparencyBlock += memoryTexts.join('\n\n---\n\n');
      transparencyBlock += `\n\n---\n`;
      transparencyBlock += `💡 **Memory quality feedback:** If any memory above is wrong, outdated, or irrelevant to this task, say so and the workflow will adapt. Your feedback helps improve future workflows.\n`;
    } else {
      transparencyBlock = `## ⚡ Memories Powering This Workflow\nNo relevant memories found in your vault for this topic. This workflow is running without historical context — the output will be generic rather than personalized.\n`;
    }

    // Build the chain suggestion with numbered steps
    let chainBlock = '';
    const chain = routeChain.length > 0 ? routeChain : (template.route_chain || []);
    if (chain.length > 0) {
      const validChain = chain.filter(c => WORKFLOW_TEMPLATES[c]);
      if (validChain.length > 0) {
        const chainSteps = validChain
          .map((c, i) => `  ${i + 1}. run_workflow(workflow="${c}") — ${WORKFLOW_TEMPLATES[c].display_name}`)
          .join('\n');
        chainBlock = `\n## Next Steps\nReply with a number to proceed:\n${chainSteps}\n`;
      }
    }

    // Build todos block if pre-loaded
    let todosBlock = '';
    if (todosResult && todosResult.status === 'fulfilled' && todosResult.value) {
      todosBlock = todosResult.value;
    }

    // Assemble the full response — transparency block FIRST so user sees context before output
    const assembled = [
      transparencyBlock,
      todosBlock,
      '',
      workflowPrompt,
      '',
      identityBlock,
      `## User Input\n${input}`,
      chainBlock,
      `\nNow execute the workflow above. Use the pre-loaded memories shown at the top for context. If the user flags any memory as irrelevant or outdated, disregard it. Adapt to the user's identity and input.`
    ].filter(Boolean).join('\n\n');

    structuredLog.info(`${toolName}: assembled`, {
      request_id: requestId,
      workflow: workflowName,
      route_confidence: routeConfidence,
      identity_loaded: !!identityBlock,
      memories_loaded: memoryTexts.length,
      assembled_length: assembled.length,
      duration_ms: Date.now() - startTime
    });

    return {
      content: [{
        type: 'text',
        text: assembled
      }]
    };

  } catch (error) {
    structuredLog.error(`${toolName}: error`, {
      request_id: requestId,
      error_message: error.message,
      duration_ms: Date.now() - startTime
    });

    return {
      content: [{
        type: 'text',
        text: `❌ Error running workflow: ${error.message}\n\nYou can still use this workflow by describing your task directly — the workflow template provides the structure, and your memories will be loaded when possible.`
      }]
    };
  }
}

export async function handleListWorkflows(args) {
  const toolName = 'list_workflows';
  structuredLog.info(`${toolName}: called`, { category: args.category || 'all' });

  // Start with hardcoded presets
  const workflows = Object.values(WORKFLOW_TEMPLATES);
  const filtered = args.category
    ? workflows.filter(wf => wf.category === args.category)
    : workflows;

  // Group by category
  const grouped = {};
  for (const wf of filtered) {
    const cat = wf.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(wf);
  }

  // Fetch user-created workflows from database
  let userCreatedCount = 0;
  try {
    const apiData = await makeApiCall('/api/v1/workflow-dashboard');
    if (apiData?.workflows) {
      const userCreated = apiData.workflows.filter(w => w.is_user_created);
      if (userCreated.length > 0) {
        userCreatedCount = userCreated.length;
        if (!grouped['custom']) grouped['custom'] = [];
        for (const uw of userCreated) {
          if (!args.category || args.category === 'custom') {
            grouped['custom'].push({
              name: uw.name,
              description: uw.description || uw.display_name || uw.name
            });
          }
        }
      }
    }
  } catch {
    // Database unavailable — show hardcoded only
  }

  const categoryLabels = {
    product: '📦 Product',
    strategy: '🎯 Strategy',
    engineering: '🔧 Engineering',
    business: '📊 Business',
    operations: '⚙️ Operations',
    content: '✍️ Content',
    custom: '⭐ Your Workflows'
  };

  let output = `🧠 Purmemo Workflows — Memory-powered processes\n`;
  output += `═══════════════════════════════════════════════\n\n`;
  output += `Each workflow automatically loads your relevant memories and identity.\n`;
  output += `Use: run_workflow(workflow="name", input="what you need")\n\n`;

  for (const [cat, label] of Object.entries(categoryLabels)) {
    if (!grouped[cat] || grouped[cat].length === 0) continue;
    output += `${label}\n`;
    for (const wf of grouped[cat]) {
      output += `  ${wf.name.padEnd(12)} — ${wf.description}\n`;
    }
    output += `\n`;
  }

  output += `Or just describe what you need:\n`;
  output += `  run_workflow(input="your goal here") → auto-routes to the right workflow\n`;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

// ============================================================================
// Sharing & Community Handlers (Migration 068)
// ============================================================================

export async function handleShareMemory(args) {
  const memoryId = args.memory_id || args.memoryId || args.id;
  const requestId = `share_memory_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  structuredLog.info(`[${requestId}] share_memory called`, { memory_id: memoryId, visibility: args.visibility });

  if (!memoryId) {
    return { content: [{ type: 'text', text: `❌ Missing required parameter: memory_id` }] };
  }

  try {
    const response = await makeApiCall(`/api/v1/memories/${memoryId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility: args.visibility })
    });

    const data = typeof response === 'string' ? JSON.parse(response) : response;

    let emoji = '🔒';
    if (args.visibility === 'public') emoji = '🌍';
    else if (args.visibility === 'unlisted') emoji = '🔗';

    let output = `${emoji} **Memory visibility updated to \`${args.visibility}\`**\n\n`;
    output += `Memory ID: \`${memoryId}\`\n`;

    if (args.visibility === 'public') {
      output += `\nThis memory is now discoverable in the community tab. Other users can find it via \`recall_public\`.\n`;
    } else if (args.visibility === 'unlisted') {
      output += `\nAnyone with the direct link can view this memory, but it won't appear in community search.\n`;
    } else {
      output += `\nThis memory is now private — only you can see it.\n`;
    }

    if (data.shared_by_username) {
      output += `\nShared as: **${data.shared_by_username}**`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    structuredLog.error(`[${requestId}] share_memory failed`, { error: error.message });
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('429') || errorMsg.includes('limit')) {
      return { content: [{ type: 'text', text: `⚠️ Share limit reached for this month.\n\nFree tier allows 5 shares/month. Upgrade to Pro ($19/mo) for unlimited sharing → https://app.purmemo.ai/settings` }] };
    }
    return { content: [{ type: 'text', text: `❌ Failed to update visibility: ${errorMsg}` }] };
  }
}

export async function handleRecallPublic(args) {
  const requestId = `recall_public_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  structuredLog.info(`[${requestId}] recall_public called`, { query: args.query, sort: args.sort });

  try {
    const params = new URLSearchParams();
    if (args.query) params.set('query', args.query);
    if (args.tag) params.set('tag', args.tag);
    if (args.platform) params.set('platform', args.platform);
    if (args.sort) params.set('sort', args.sort);
    params.set('page', String(args.page || 1));
    params.set('page_size', '10');

    const response = await makeApiCall(`/api/v1/memories/public?${params.toString()}`, {
      method: 'GET'
    });

    const data = typeof response === 'string' ? JSON.parse(response) : response;

    if (!data.memories || data.memories.length === 0) {
      return { content: [{ type: 'text', text: `🔍 No public memories found${args.query ? ` for "${args.query}"` : ''}.\n\nThe community knowledge base is still growing. Be the first to share! Use \`share_memory\` to make your memories public.` }] };
    }

    let output = `🌍 **Community Memories** (${data.total} found${args.query ? ` for "${args.query}"` : ''})\n\n`;

    const platformEmoji = {
      chatgpt: '🤖', claude: '🟣', 'claude-code': '🟣', gemini: '💎',
      cursor: '⚡', codex: '🧬', figma: '🎨', 'purmemo-web': '🧠'
    };

    for (const mem of data.memories) {
      const pEmoji = platformEmoji[mem.platform] || '📝';
      const author = mem.shared_by_username || 'Anonymous';
      const recallBadge = mem.recall_count_public > 0 ? ` (${mem.recall_count_public} recalls)` : '';

      output += `---\n`;
      output += `${pEmoji} **${mem.title || 'Untitled'}**${recallBadge}\n`;
      output += `*Shared by ${author}*`;
      if (mem.shared_at) {
        const sharedDate = new Date(mem.shared_at);
        output += ` on ${sharedDate.toLocaleDateString()}`;
      }
      output += `\n\n`;

      // Content preview (truncated at 300 chars for list view)
      const preview = (mem.content || '').slice(0, 300);
      output += `${preview}${(mem.content || '').length > 300 ? '...' : ''}\n\n`;

      if (mem.tags && mem.tags.length > 0) {
        output += `Tags: ${mem.tags.map(t => `\`${t}\``).join(', ')}\n`;
      }

      output += `🔗 ID: \`${mem.id}\` — use \`get_public_memory\` for full content\n\n`;
    }

    if (data.has_more) {
      output += `\n📄 Page ${data.page} of ${Math.ceil(data.total / data.page_size)} — use \`page: ${data.page + 1}\` for more results.`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    structuredLog.error(`[${requestId}] recall_public failed`, { error: error.message });
    return { content: [{ type: 'text', text: `❌ Failed to search public memories: ${error.message || String(error)}` }] };
  }
}

export async function handleGetPublicMemory(args) {
  const memoryId = args.memory_id || args.memoryId || args.id;
  const requestId = `get_public_memory_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  structuredLog.info(`[${requestId}] get_public_memory called`, { memory_id: memoryId });

  if (!memoryId) {
    return { content: [{ type: 'text', text: `❌ Missing required parameter: memory_id` }] };
  }

  try {
    const response = await makeApiCall(`/api/v1/memories/public/${memoryId}`, {
      method: 'GET'
    });

    const data = typeof response === 'string' ? JSON.parse(response) : response;

    if (!data || !data.id) {
      return { content: [{ type: 'text', text: `❌ Memory \`${memoryId}\` not found or is not public.` }] };
    }

    const platformEmoji = {
      chatgpt: '🤖', claude: '🟣', 'claude-code': '🟣', gemini: '💎',
      cursor: '⚡', codex: '🧬', figma: '🎨', 'purmemo-web': '🧠'
    };

    const pEmoji = platformEmoji[data.platform] || '📝';
    const author = data.shared_by_username || 'Anonymous';

    let output = `${pEmoji} **${data.title || 'Untitled'}**\n`;
    output += `*Shared by ${author}*`;
    if (data.shared_at) {
      output += ` on ${new Date(data.shared_at).toLocaleDateString()}`;
    }
    output += ` | ${data.recall_count_public || 0} recalls | ${data.word_count || 0} words\n\n`;

    if (data.tags && data.tags.length > 0) {
      output += `Tags: ${data.tags.map(t => `\`${t}\``).join(', ')}\n\n`;
    }

    if (data.observations && data.observations.length > 0) {
      output += `**Key Insights:**\n`;
      for (const obs of data.observations.slice(0, 10)) {
        const text = typeof obs === 'object' ? (obs.text || obs.fact || obs.observation || JSON.stringify(obs)) : obs;
        output += `• ${text}\n`;
      }
      output += `\n`;
    }

    output += `---\n\n`;
    output += data.content || '(No content)';

    const sanitizedText = sanitizeUnicode(output);
    return { content: [{ type: 'text', text: sanitizedText }] };
  } catch (error) {
    structuredLog.error(`[${requestId}] get_public_memory failed`, { error: error.message });
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('404')) {
      return { content: [{ type: 'text', text: `❌ Memory \`${memoryId}\` not found or is not public.` }] };
    }
    return { content: [{ type: 'text', text: `❌ Failed to retrieve public memory: ${errorMsg}` }] };
  }
}

export async function handleReportMemory(args) {
  const memoryId = args.memory_id || args.memoryId || args.id;
  const requestId = `report_memory_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  structuredLog.info(`[${requestId}] report_memory called`, { memory_id: memoryId, reason: args.reason });

  if (!memoryId) {
    return { content: [{ type: 'text', text: `❌ Missing required parameter: memory_id` }] };
  }

  try {
    const response = await makeApiCall(`/api/v1/memories/${memoryId}/report`, {
      method: 'POST',
      body: JSON.stringify({
        reason: args.reason,
        description: args.description || null
      })
    });

    const data = typeof response === 'string' ? JSON.parse(response) : response;

    return {
      content: [{
        type: 'text',
        text: `✅ **Report submitted** for memory \`${memoryId}\`\n\nReason: ${args.reason}\n${data.message || 'Thank you for helping keep the community safe.'}`
      }]
    };
  } catch (error) {
    structuredLog.error(`[${requestId}] report_memory failed`, { error: error.message });
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('409') || errorMsg.includes('already reported')) {
      return { content: [{ type: 'text', text: `ℹ️ You have already reported this memory. Our team will review it.` }] };
    }
    return { content: [{ type: 'text', text: `❌ Failed to report memory: ${errorMsg}` }] };
  }
}

export async function handleGetAcknowledgedErrors(args) {
  try {
    const limit = args.limit || 10;
    const levelFilter = args.level_filter || 'all';
    const minOccurrences = args.min_occurrences || 1;

    const response = await makeApiCall(
      `/api/v1/admin/acknowledged-errors?limit=${limit}&level_filter=${levelFilter}&min_occurrences=${minOccurrences}`,
      { method: 'GET' }
    );

    if (!response.acknowledged_errors || response.acknowledged_errors.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `✅ No open errors found!\n\nAll errors have been resolved or none have occurred since the last deploy.`
        }]
      };
    }

    const errorList = response.acknowledged_errors.map((err, idx) => {
      let output = `\n${idx + 1}. **${err.level.toUpperCase()}** (ID: ${err.id})
   Message: ${err.message}
   Occurrences: ${err.occurrence_count}
   First Seen: ${err.first_seen_at}
   Last Seen: ${err.last_seen_at}
   Source: ${err.source}`;

      // Recent occurrences — per-request context from TypeScript API
      if (err.recent_occurrences && err.recent_occurrences.length > 0) {
        output += `\n\n   📍 RECENT OCCURRENCES (${err.recent_occurrences.length}):`;
        err.recent_occurrences.forEach((occ, i) => {
          output += `\n   ${i + 1}. [${new Date(occ.created_at).toISOString()}]`;
          if (occ.method && occ.path) output += ` ${occ.method} ${occ.path}`;
          if (occ.user_id) output += ` — user: ${occ.user_id}`;
        });
      } else if (err.metadata) {
        // First-seen context on the incident itself
        if (err.metadata.path || err.metadata.method) {
          output += `\n\n   📍 FIRST SEEN CONTEXT:`;
          if (err.metadata.method && err.metadata.path) output += `\n   ${err.metadata.method} ${err.metadata.path}`;
          if (err.metadata.node_version) output += ` (Node ${err.metadata.node_version})`;
        }
      }

      if (err.similar_investigations && err.similar_investigations.length > 0) {
        output += `\n\n   🔄 SIMILAR PAST FIXES (${err.similar_investigations.length}):`;
        err.similar_investigations.forEach((inv, i) => {
          output += `\n\n   ${i + 1}. Fixed ${inv.fixed_at ? new Date(inv.fixed_at).toLocaleDateString() : 'previously'}`;
          if (inv.root_cause) output += `\n      Root Cause: ${inv.root_cause}`;
          if (inv.fix_type) output += `\n      Fix Type: ${inv.fix_type}`;
          if (inv.confidence !== null && inv.confidence !== undefined) {
            output += `\n      Confidence: ${(inv.confidence * 100).toFixed(0)}%`;
          }
          if (inv.risk_level) output += `\n      Risk: ${inv.risk_level}`;
          if (inv.commit_hash) output += `\n      Commit: ${inv.commit_hash.substring(0, 7)}`;
        });
        output += `\n\n   💡 TIP: We've fixed this error before! Review the past fixes above.`;
      }

      return output;
    }).join('\n');

    return {
      content: [{
        type: 'text',
        text: `🔍 Found ${response.total_count} Open Error${response.total_count === 1 ? '' : 's'}\n\nFilters Applied: Level=${levelFilter}, Min Occurrences=${minOccurrences}\n${errorList}\n\n📝 Next Steps:\n1. Choose an error to investigate\n2. Use recall_memories to check if we've seen similar errors\n3. Use search_web_ai to research solutions\n4. Use Context7 for library-specific docs\n5. Propose fix with confidence score\n6. Deploy fix when approved\n7. Call save_investigation_result to store audit trail (auto-resolves incident when deployment_results.success=true)`
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error fetching acknowledged errors: ${error.message}\n\nMake sure:\n1. Backend API is running\n2. You have admin permissions\n3. Error tracking service is active`
      }]
    };
  }
}

export async function handleSaveTestResult(args) {
  try {
    const projectName = (args.project_name || '').trim();
    const testSuite = (args.test_suite || '').trim();

    if (!projectName || !testSuite) {
      return {
        content: [{ type: 'text', text: '❌ Missing required fields: project_name and test_suite' }]
      };
    }
    if (typeof args.passed !== 'boolean') {
      return {
        content: [{ type: 'text', text: '❌ Missing required field: passed (must be true or false)' }]
      };
    }

    const response = await makeApiCall(
      `/api/v1/projects/${encodeURIComponent(projectName)}/test_results`,
      {
        method: 'POST',
        body: JSON.stringify({
          passed: args.passed,
          test_suite: testSuite,
          ...(args.failure_details ? { failure_details: args.failure_details } : {})
        })
      }
    );

    const statusEmoji = args.passed ? '✅' : '❌';
    const lines = [
      `${statusEmoji} Test Result Saved — ${testSuite}`,
      ``,
      `Status: ${response.status}`,
      `Project: ${response.project_name}`,
      `Memory ID: ${response.id ?? response.memory_id}`,
      response.linked_task
        ? `Linked Task: #${response.linked_task.sequence} — ${response.linked_task.title}`
        : `Linked Task: none (no active task for this project)`,
    ].join('\n');

    return { content: [{ type: 'text', text: lines }] };

  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error saving test result: ${error.message}` }]
    };
  }
}

export async function handleGetNextTask(args) {
  try {
    const projectName = (args.project_name || '').trim();
    if (!projectName) {
      return {
        content: [{
          type: 'text',
          text: '❌ Missing required field: project_name'
        }]
      };
    }

    const sessionId = readCurrentSessionId();
    const headers: Record<string, string> = {};
    if (sessionId) headers['x-session-id'] = sessionId;

    const response = await makeApiCall(
      `/api/v1/projects/${encodeURIComponent(projectName)}/next_task`,
      { method: 'GET', headers }
    );

    if (!response.task) {
      return {
        content: [{
          type: 'text',
          text: `✅ No pending tasks for project "${projectName}". All done!`
        }]
      };
    }

    const task = response.task;
    const lines = [
      `📋 NEXT TASK — ${projectName}`,
      ``,
      `Task #${task.sequence}: ${task.title}`,
      task.description ? `\nDescription:\n${task.description}` : '',
      task.acceptance_criteria ? `\nAcceptance Criteria:\n${task.acceptance_criteria}` : '',
      task.context_brief ? `\nPRD Context:\n${task.context_brief}` : '',
      ``,
      `Task ID: ${task.id}`,
      `Remaining after this: ${Math.max(0, task.total_remaining - 1)} pending task(s)`,
      ``,
      `When done, call complete_task({ task_id: "${task.id}", verification_summary: "..." })`
    ].filter(l => l !== undefined).join('\n');

    return {
      content: [{
        type: 'text',
        text: lines
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error fetching next task: ${error.message}`
      }]
    };
  }
}

export async function handleCompleteTask(args) {
  try {
    const taskId = (args.task_id || '').trim();
    const verificationSummary = (args.verification_summary || '').trim();

    if (!taskId) {
      return { content: [{ type: 'text', text: '❌ Missing required field: task_id' }] };
    }
    if (!verificationSummary) {
      return { content: [{ type: 'text', text: '❌ Missing required field: verification_summary' }] };
    }

    // Extract project name from task_id context — passed separately or derived at call time
    const projectName = (args.project_name || '').trim();
    if (!projectName) {
      return { content: [{ type: 'text', text: '❌ Missing required field: project_name' }] };
    }

    const response = await makeApiCall(
      `/api/v1/projects/${encodeURIComponent(projectName)}/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({ verification_summary: verificationSummary }),
      }
    );

    if (response.error) {
      return { content: [{ type: 'text', text: `❌ ${response.error}` }] };
    }

    const { completed, next_task, message } = response;
    const lines = [
      `✅ ${message}`,
      ``,
      `Completed: Task #${completed.sequence} — ${completed.title}`,
    ];

    if (next_task) {
      lines.push(``, `⬇️  Next: Task #${next_task.sequence} — ${next_task.title}`);
      lines.push(`Call get_next_task({ project_name: "${projectName}" }) to begin.`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };

  } catch (error) {
    return { content: [{ type: 'text', text: `❌ Error completing task: ${error.message}` }] };
  }
}

export async function handleSaveInvestigation(args) {
  try {
    if (!args.incident_id) {
      return {
        content: [{
          type: 'text',
          text: `❌ Missing required field: incident_id\n\nPlease provide the incident_id from get_acknowledged_errors.`
        }]
      };
    }

    const response = await makeApiCall('/api/v1/admin/investigations', {
      method: 'POST',
      body: JSON.stringify(args)
    });

    if (response.success) {
      return {
        content: [{
          type: 'text',
          text: `✅ Investigation Saved Successfully!\n\n📋 Investigation ID: ${response.investigation_id}\n🔗 Incident ID: ${response.incident_id}\n📊 Status: ${response.investigation_status}\n🚀 Deployment: ${response.deployment_status}\n\n${args.deployment_commit_hash ? `✓ Deployed with commit: ${args.deployment_commit_hash}` : '⏳ Awaiting deployment'}\n\nThis investigation is now part of the audit trail and can be used to learn from similar errors in the future.`
        }]
      };
    } else {
      return {
        content: [{
          type: 'text',
          text: `⚠️ Investigation saved with warnings:\n\n${JSON.stringify(response, null, 2)}`
        }]
      };
    }

  } catch (error) {
    // Sanitize DB errors — don't leak table/column names
    let userMessage = error.message;
    if (userMessage.includes('foreign key') || userMessage.includes('violates') || userMessage.includes('constraint')) {
      userMessage = 'Incident not found. Please verify the incident_id exists in get_acknowledged_errors.';
    }
    return {
      content: [{
        type: 'text',
        text: `❌ Error saving investigation: ${userMessage}\n\nPlease check:\n1. incident_id is valid (from get_acknowledged_errors)\n2. Backend API is running\n3. You have admin permissions`
      }]
    };
  }
}
