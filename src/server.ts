#!/usr/bin/env node
// @ts-nocheck — 4665-line server, full typing in incremental follow-ups
/**
 * pūrmemo MCP Server - Unified TypeScript (version from package.json)
 *
 * Comprehensive solution that combines all our learnings:
 * - Smart content detection and routing
 * - Aggressive prompting for complete capture
 * - Automatic chunking for large content
 * - Artifact and code block extraction
 * - Session management for multi-part saves
 * - Living document pattern with auto-ID from title
 * - 🌍 Cross-platform discovery via semantic clusters
 * - 🔗 Find related conversations across ChatGPT, Claude, Gemini
 * - 🧠 NEW: Intelligent memory saving with auto-context extraction
 * - 📊 NEW: Automatic project/component/feature detection
 * - 🎯 NEW: Smart title generation (no more timestamps!)
 * - 🗺️ NEW: Roadmap tracking across AI tools
 * - 🛡️ PHASE 16.4: Unicode sanitization to prevent JSON encoding errors
 *   - Fixes "no low surrogate" errors from corrupted Unicode in memories
 *   - Automatically cleans all text before sending to Claude API
 *   - Prevents 400 errors caused by unpaired surrogate characters
 * - 🎯 NEW: Workflow Engine (run_workflow + list_workflows)
 *   - Memory-powered workflow execution via MCP tools
 *   - 15 bundled universal workflows (prd, ceo, debug, growth, etc.)
 *   - Intent-based auto-routing when no workflow specified
 *   - Pre-loads user identity + relevant memories server-side
 * - 📋 MCP Spec 2025-11-25 Compliance:
 *   - Server instructions for LLM guidance at connection time
 *   - outputSchema on all 4 tools for structured tool output
 *   - Tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
 * - 🛡️ TIER 3 PRODUCTION HARDENING:
 *   - Structured JSON logging for all operations
 *   - Circuit breaker pattern for API resilience
 *   - 30-second request timeouts with AbortController
 *   - Per-tool request timing and metrics
 *   - Safe error messages with fallback handling
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// SSEServerTransport kept for legacy /sse endpoint (Claude Desktop)
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import {
  extractProjectContext,
  generateIntelligentTitle,
  extractProgressIndicators,
  extractRelationships
} from './intelligent-memory.js';
import TokenStore from './auth/token-store.js';
import { detectInstallMethod } from './auth/install-detection.js';
import { structuredLog, logStructured } from './lib/logger.js';
import {
  initApiClient,
  CircuitBreaker,
  CircuitBreakerOpenError,
  apiCircuitBreaker,
  safeErrorMessage,
  sanitizeUnicode,
  makeApiCall
} from './lib/api-client.js';
import {
  initHandlers,
  handleSaveConversation,
  handleSaveArtifact,
  handleCommit,
  handleSnapshot,
  handleDiscoverRelated,
  handleRecallMemories,
  handleGetMemoryDetails,
  handleGetUserContext,
  handleRunWorkflow,
  handleListWorkflows,
  handleShareMemory,
  handleRecallPublic,
  handleGetPublicMemory,
  handleReportMemory,
  handleGetAcknowledgedErrors,
  handleSaveInvestigation,
  handleSaveTestResult,
  handleGetNextTask,
  handleCompleteTask,
  handleSnapshotSources,
  handleSaveSnapshot,
  handleGetSnapshot,
  handleAcceptSnapshot
} from './tools/handlers.js';
import { handleGenerateHandoffBrief } from './tools/handoff.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Route subcommands and flags through setup.js.
//
// Dispatch:
//   • Known subcommand (e.g. `purmemo init`)        → setup.js
//   • Unknown positional arg (e.g. `purmemo lgout`) → setup.js help, exit 1
//   • Bare `purmemo` from interactive terminal      → setup.js (runs init)
//   • Bare `purmemo` from MCP client (stdin is not a TTY, e.g. Claude
//     Desktop / Claude Code spawning via stdio)     → start MCP server
//   • `purmemo --remote` (or PURMEMO_REMOTE=1)      → start MCP server
//
// The "bare interactive" case is the fix for the v15.7.1 UX bug: typing
// just `purmemo` in a terminal used to dump JSON logs because we always
// started the server. MCP clients still get the server because they pipe
// stdin and `process.stdin.isTTY` is undefined.
const _arg = process.argv[2];
const _subcommands = new Set([
  'setup', 'init', 'status', 'where', 'uninstall', 'logout', 'hooks',
  'accounts', 'use', 'add', 'remove',
  'update', 'help',
  '--update', '--help', '-h',
]);
const _serverFlags = new Set(['--remote']);
const _isRemoteMode = process.argv.includes('--remote') || process.env.PURMEMO_REMOTE === '1';
const _isInteractiveTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;

if (_arg && _subcommands.has(_arg)) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const setupPath = path.join(__dirname, 'setup.js');
  import(setupPath).catch(err => { console.error(err); process.exit(1); });
  // setup.js manages its own process lifecycle
} else if (_arg && !_arg.startsWith('-') && !_serverFlags.has(_arg)) {
  // Positional non-flag arg that isn't a known subcommand → typo.
  // Route to setup.js's help path so the user sees the command list.
  process.argv[2] = 'help';
  console.error(`Unknown command: ${_arg}\n`);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const setupPath = path.join(__dirname, 'setup.js');
  import(setupPath).then(() => process.exit(1)).catch(err => { console.error(err); process.exit(1); });
} else if (!_arg && _isInteractiveTTY && !_isRemoteMode) {
  // Bare `purmemo` typed in a terminal → the user wants to set up, not
  // start a stdio MCP server. Defer to setup.js which defaults to init.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const setupPath = path.join(__dirname, 'setup.js');
  import(setupPath).catch(err => { console.error(err); process.exit(1); });
} else {

const API_URL = (process.env.PURMEMO_API_URL || 'https://api.purmemo.ai').replace(/\/+$/, '');

// API client is initialized below — after CLIENT_VERSION and PLATFORM are
// computed — so the User-Agent header includes version + install method +
// platform.

// ============================================================================
// Version check — runs once on startup, non-blocking
// If the server reports this client is below min_required_version, every tool
// response will include an update notice at the top.
// ============================================================================

const require = createRequire(import.meta.url);
// In .mcpb bundles, package.json is at ./package.json (same dir as server.js)
// In npx installs, it's at ../package.json — try both
let CLIENT_VERSION = '0.0.0';
try { CLIENT_VERSION = require('./package.json').version; } catch {
  try { CLIENT_VERSION = require('../package.json').version; } catch { /* unknown */ }
}

let _updateNotice = null; // set to a string if an update is required

function semverLt(a, b) {
  // Returns true if version string a is less than b (simple numeric comparison)
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdates() {
  try {
    const res = await fetch(`${API_URL}/api/v1/mcp/version`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json();
    const { latest_version, min_required_version, update_instructions } = data;
    if (semverLt(CLIENT_VERSION, min_required_version)) {
      _updateNotice = `⚠️ pūrmemo MCP update required (you: v${CLIENT_VERSION}, required: v${min_required_version}). ${update_instructions}`;
      structuredLog.warn('MCP client below minimum required version', { client: CLIENT_VERSION, required: min_required_version });
    } else if (semverLt(CLIENT_VERSION, latest_version)) {
      _updateNotice = `ℹ️ pūrmemo MCP update available (you: v${CLIENT_VERSION}, latest: v${latest_version}). ${update_instructions}`;
      structuredLog.info('MCP client update available', { client: CLIENT_VERSION, latest: latest_version });
    }
  } catch {
    // Version check is best-effort — never block startup
  }
}

// Read current Claude Code session_id from hook state file (written by session_start hook)
// Returns null if not in a Claude Code session or state file unavailable
function readCurrentSessionId() {
  try {
    const stateFile = path.join(os.homedir(), '.claude', 'hooks', 'purmemo_state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state.current_session_id || null;
  } catch {
    return null;
  }
}

// API key — resolved from ~/.purmemo/auth.json at startup (single source of truth)
let resolvedApiKey: string | null = null;

// Last recall result cache — maps ordinal "1"-"N" to UUID for get_memory_details
let lastRecallIds = [];

// Log API configuration
structuredLog.info('API configuration loaded', {
  api_url: API_URL,
  api_key_present: !!resolvedApiKey,
  api_key_source: resolvedApiKey ? 'env' : 'pending'
});

// Platform detection: user specifies via MCP_PLATFORM env var
// Supported: 'claude', 'claude-code', 'cursor', 'chatgpt', 'codex', 'gemini', 'windsurf', 'zed'
// MCP is a universal protocol - same server works across all platforms
// Auto-detect Claude Code vs Claude Desktop
const detectPlatform = () => {
  // 1. Explicit override (highest priority)
  if (process.env.MCP_PLATFORM) {
    return process.env.MCP_PLATFORM;
  }

  // 2. Auto-detect Claude Code via env vars set by Claude Code CLI
  // Claude Code sets CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT=cli
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT === 'cli') {
    return 'claude-code';
  }

  // 3. Default to claude for Claude Desktop
  return 'claude';
};

const PLATFORM = detectPlatform();

// Detect install method (global / npx / local / unknown) for telemetry.
// Best-effort — only used to populate the User-Agent header.
let INSTALL_METHOD: string;
try {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let globalRoot: string | null = null;
  try {
    const out = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
    globalRoot = out.toString().trim() || null;
  } catch { /* npm root -g may fail or be slow — best-effort only */ }
  INSTALL_METHOD = detectInstallMethod(packageDir, globalRoot);
} catch {
  INSTALL_METHOD = 'unknown';
}

// Initialize extracted API client with URL + lazy key resolver + telemetry
// fields (version / install method / platform). Surfaces in the User-Agent.
initApiClient({
  apiUrl: API_URL,
  resolveApiKey: () => resolvedApiKey,
  clientVersion: CLIENT_VERSION,
  installMethod: INSTALL_METHOD,
  platform: PLATFORM,
});

// Admin mode: enables get_acknowledged_errors + save_investigation_result
// Only enabled when PURMEMO_ADMIN=1 is set in the environment.
// Never set by default — npm package users never see these tools.
const ADMIN_MODE = process.env.PURMEMO_ADMIN === '1';

// Log detected platform for debugging (only in development)
if (process.env.NODE_ENV !== 'production') {
  structuredLog.debug('Platform detected', { platform: PLATFORM });
  structuredLog.debug('Admin mode', { admin_mode: ADMIN_MODE });
}

// Session management for chunked captures
const sessions = {
  active: new Map(),
  completed: new Map()
};

// Initialize extracted tool handlers with server-scoped dependencies
initHandlers({
  platform: PLATFORM,
  getLastRecallIds: () => lastRecallIds,
  setLastRecallIds: (ids) => { lastRecallIds = ids; },
  readCurrentSessionId
});

// ULTIMATE TOOL DEFINITIONS
// MCP Tool Annotations (Anthropic Connector Directory Requirement #17)
// - readOnlyHint: true for tools that only read data, false for write operations
// - destructiveHint: true for tools that delete/modify existing data destructively
// - idempotentHint: true for tools that produce same result when called multiple times
// - openWorldHint: true for tools that interact with external world beyond local data
// - title: Human-readable title for display in UIs
const TOOLS = [
  {
    name: 'save_conversation',
    annotations: {
      title: 'Save Conversation',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    _meta: {
      'openai/outputTemplate': 'ui://widgets/save.html',
      'openai/toolInvocation/invoking': 'Saving to your memory vault...',
      'openai/toolInvocation/invoked': 'Saved to memory',
      'openai/widgetAccessible': true,
      'openai/widgetDomain': 'save.widgets.purmemo.ai'
    },
    description: `Save complete conversations as memory. REQUIRED: Send COMPLETE conversation in 'conversationContent' parameter (minimum 100 chars, should be thousands). Include EVERY message verbatim - NO summaries or partial content.

    Intelligently tracks context, extracts project details, and routes to a single memory per conversation topic.

    HOW SAVES TARGET MEMORIES:
    - conversationId is auto-generated from title slug (e.g., "MCP Tools" → "mcp-tools")
    - Same title (or explicit conversationId) → targets the existing memory
    - The 'mode' parameter controls what happens to that existing memory:
      • mode='replace' (default): overwrites the existing content with what you send
      • mode='append': concatenates new content below existing with a timestamped separator
        (\\n\\n--- UPDATE <ISO8601> ---\\n\\n) — preserves all prior history in the live row
    - The /save skill sets mode='append' automatically for living-document use
    - For one-shot snapshots, ad-hoc captures, or explicit overwrite: pass mode='replace'

    PRIOR CONTENT IS NEVER LOST:
    - Even with mode='replace', prior content is snapshotted to memory_events audit log on every update
    - Recovery from overwrites requires a one-off script (out-of-band)
    - Use mode='append' if you want history to remain visible inline in the live memory

    INTELLIGENT EXTRACTION (independent of mode):
    - Auto-extracts project context (name, component, feature being discussed)
    - Detects work iteration and status (planning/in_progress/completed/blocked)
    - Generates smart titles like "Purmemo - Timeline View - Implementation"
    - Tracks technologies, tools used, identifies relationships/dependencies

    SERVER AUTO-CHUNKING:
    - Large conversations (>15K chars) automatically split into linked chunks
    - Small conversations (<15K chars) saved directly as single memory
    - You always send complete content — server handles chunking
    - APPEND + CHUNKING: append mode works only for content <15K chars. Saves >15K
      with mode='append' are rejected with a clear error — appending to chunked
      storage would double each chunk's content on re-save. For long-running living
      docs, send only the new delta since the last save (keep it <15K) or use
      mode='replace' for full re-saves.
    - KNOWN CAVEAT: a doc that is saved small (single memory) and later grows past 15K
      transitions to chunked storage at a new conversation_id space — the original
      single memory becomes orphaned. Tracked under ADR-038 (uniform namespace).

    EXAMPLES:
    User: "Save progress" via /save skill
    → /save sets mode='append'; new content is appended below prior content

    User: "Save this snapshot" (one-shot capture)
    → mode='replace' default; current content overwrites any existing memory at this title

    User: "Save as conversation react-hooks-guide" with explicit append
    → save_conversation(conversationId="react-hooks-guide", mode="append")
    → Appends to existing memory at that ID (or creates if new)

    WHAT TO INCLUDE (COMPLETE CONVERSATION REQUIRED):
    - EVERY user message (verbatim, not paraphrased)
    - EVERY assistant response (complete, not summarized)
    - ALL code blocks with full syntax
    - ALL artifacts with complete content (not just titles/descriptions)
    - ALL file paths, URLs, and references mentioned
    - ALL system messages and tool outputs
    - EXACT conversation flow and context
    - Minimum 500 characters expected - should be THOUSANDS of characters

    FORMAT REQUIRED:
    === CONVERSATION START ===
    [timestamp] USER: [complete user message 1]
    [timestamp] ASSISTANT: [complete assistant response 1]
    [timestamp] USER: [complete user message 2]
    [timestamp] ASSISTANT: [complete assistant response 2]
    ... [continue for ALL exchanges]
    === ARTIFACTS ===
    [Include ALL artifacts with full content]
    === CODE BLOCKS ===
    [Include ALL code with syntax highlighting]
    === END ===

    IMPORTANT: Do NOT send just "save this conversation" or summaries. If you send less than 500 chars, you're doing it wrong. Include the COMPLETE conversation with all details.

    ARTIFACT PRESERVATION (ADR-025):
    If this conversation produced artifacts (research reports, tables, frameworks, specs, design documents),
    save them SEPARATELY using save_artifact after this call.
    Flow: save_conversation first, then save_artifact for each artifact.
    This ensures artifacts are preserved in full — do not try to embed large artifacts in conversationContent.`,
    inputSchema: {
      type: 'object',
      properties: {
        conversationContent: {
          type: 'string',
          description: 'COMPLETE conversation transcript - minimum 500 characters expected. Include EVERYTHING discussed.',
          minLength: 100
        },
        title: {
          type: 'string',
          description: 'Title for this conversation memory',
          default: `Conversation ${new Date().toISOString()}`
        },
        conversationId: {
          type: 'string',
          description: 'Optional unique identifier for living document pattern. If provided and memory exists with this conversationId, UPDATES that memory instead of creating new one. Use for maintaining single memory per conversation that updates over time.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
          default: ['complete-conversation']
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Priority level for this memory',
          default: 'medium'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'How to handle a save that targets an existing memory (same title or conversationId). "replace" (default) overwrites the existing content with what you send. "append" concatenates new content below the existing content with a timestamped separator (\\n\\n--- UPDATE <ISO8601> ---\\n\\n). Use "append" for living documents you genuinely want to grow over time; use "replace" for one-shot snapshots and ad-hoc captures. The /save skill defaults to "append" automatically — you only need to pass this for explicit overrides.',
          default: 'replace'
        }
      },
      required: ['conversationContent']
    }
  },
  // ADR-025: Artifact Preservation — save artifacts separately from conversations
  {
    name: 'save_artifact',
    annotations: {
      title: 'Save Artifact',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: `Save a single artifact (research report, table, framework, spec, code) linked to a conversation memory.

WHEN TO USE: After calling save_conversation for a session that produced artifacts.
Call this ONCE PER ARTIFACT with the full verbatim content — do NOT summarize or truncate.

WHY: Artifacts are the highest-value output of research sessions. Saving them separately ensures
complete preservation. Each artifact becomes a first-class searchable object linked to its parent conversation.

FLOW:
1. save_conversation(title="Research Session", conversationId="my-research") → saves the conversation transcript
2. save_artifact(conversationId="my-research", title="Competitive Analysis", type="research", content="<FULL artifact>")
3. save_artifact(conversationId="my-research", title="Ranking Table", type="table", content="<FULL table>")

IMPORTANT: Send the COMPLETE artifact content in the content field. The entire point of this tool
is to preserve artifacts that would otherwise be lost or summarized. Minimum 100 characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'The conversationId of the parent memory to link this artifact to. Must match the conversationId used in save_conversation.'
        },
        title: {
          type: 'string',
          description: 'Title of this artifact (e.g., "Competitive Analysis Report", "Architecture Ranking Table", "Implementation Spec")'
        },
        type: {
          type: 'string',
          enum: ['research', 'code', 'table', 'framework', 'spec', 'diagram', 'other'],
          description: 'Type of artifact'
        },
        content: {
          type: 'string',
          description: 'COMPLETE artifact content — the full verbatim text, not a summary.',
          minLength: 100
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
          default: []
        }
      },
      required: ['conversationId', 'title', 'type', 'content']
    }
  },
  // ADR-032 / ADR-034: Commitment-shaped write primitive (PRD, ADR, spec, OKR).
  {
    name: 'commit',
    annotations: {
      title: 'Commit a Commitment-Shaped Artifact',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: `Persist a commitment-shaped artifact (PRD, ADR, spec, OKR) as a memory with intent='commitment'.

WHEN TO USE: This is the write primitive for /prd, /decide, /spec, /commit slash commands. Call after the artifact is fully drafted in the conversation. Send the COMPLETE artifact verbatim — do NOT summarize.

INSERT-only. Each call creates a new memory; supersede prior versions by recency, never overwrite. No conversationId parameter (intentional — see ADR-034).

QUERYABLE: GET /api/v1/commitments/?type=<type> returns all commitments of a given type, filterable by target_date and sorted by recency.

EXAMPLES:
- commit(title="ADR-035 - Foo - Bar - 2026-04-28", type="ADR", content="<full ADR markdown>", key_result="single-sentence chosen-option statement")
- commit(title="PRD - Email verification flow", type="PRD", content="<full PRD>", target_date="2026-05-15")`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title following the pattern "[Type]-NNN - [Project] - [Subject] - [Date]" for ADRs, or "[Project] - [Type] - [Feature]" for PRDs/specs.'
        },
        commitment_type: {
          type: 'string',
          enum: ['PRD', 'ADR', 'spec', 'OKR', 'other'],
          description: 'The kind of commitment.'
        },
        content: {
          type: 'string',
          description: 'COMPLETE artifact content, verbatim — the full markdown body of the PRD/ADR/spec/OKR.',
          minLength: 100
        },
        key_result: {
          type: 'string',
          description: 'Optional one-sentence concrete deliverable. What is true when this commitment is honored?',
          maxLength: 2000
        },
        target_date: {
          type: 'string',
          description: 'Optional target date in YYYY-MM-DD format. Omit if no deadline.',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization. "commitment" and the lowercased commitment_type are added automatically.',
          default: []
        }
      },
      required: ['title', 'commitment_type', 'content']
    }
  },
  // ADR-032 / ADR-034: Snapshot — generate a state-shaped artifact for a topic.
  {
    name: 'snapshot',
    annotations: {
      title: 'Generate a Snapshot for a Topic',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: `Generate a state-shaped artifact for a topic from your saved memories.

WHEN TO USE: When you want a current-state document derived from saved conversations — architecture map, glossary, runbook, manifesto, project state. The slash command /snapshot calls this.

HOW IT WORKS:
1. Queries memories matching the topic (fuzzy match against tags + title), recency-weighted.
2. Builds a draft snapshot via the deterministic baseline generator (concatenates source memories — Phase 1 baseline; Gemini integration ships later).
3. Computes evidence_tier (A/B/C, deterministic) and grounded_ratio (claim verification).
4. Persists as status='draft'. Promotion to canonical requires explicit POST /api/v1/snapshots/{id}/accept per ADR-032.

INSERT-only — each call creates a new draft (versioned). Two snapshots of the same topic both exist; supersede via /accept.

EXAMPLES:
- snapshot(topic: "architecture") — gathers all memories tagged or titled with "architecture"
- snapshot(topic: "auth") — pulls everything auth-related, recency-weighted`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic to snapshot. A keyword that fuzzy-matches memory tags and titles. Examples: "architecture", "glossary", "auth", "onboarding".',
          minLength: 1,
          maxLength: 200
        }
      },
      required: ['topic']
    }
  },
  // ADR-032 Amendment A: MCP agentic path — Claude synthesizes, no Gemini call.
  {
    name: 'snapshot_sources',
    annotations: { title: 'Get Snapshot Sources', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: `Fetch citation bundle + conflict detection for a topic so YOU can synthesize the snapshot in-context. Step 1 of the MCP snapshot path (ADR-032 Amendment A).

WHEN TO USE: When you want to generate a snapshot from inside Claude. Returns source memories + conflicts so you synthesize, then call save_snapshot() to persist.

FLOW:
1. snapshot_sources(topic) → sources returned to you
2. You synthesize a current-state document from the sources
3. save_snapshot(topic, content, cited_ids) → persists your synthesis as a draft
4. accept_snapshot(snapshot_id) → promotes to canonical`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic keyword — fuzzy matches memory tags and titles.', minLength: 1, maxLength: 200 }
      },
      required: ['topic']
    }
  },
  {
    name: 'save_snapshot',
    annotations: { title: 'Save Snapshot Draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: `Persist your synthesized snapshot content as a draft. Step 3 of the MCP snapshot path (ADR-032 Amendment A).

Call this after synthesizing from snapshot_sources(). Backend derives evidence_tier from cited_ids — not caller-controlled. Runs claim verification on your content.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic this snapshot covers.', minLength: 1, maxLength: 200 },
        content: { type: 'string', description: 'Your synthesized snapshot content (markdown). Min 100 chars.', minLength: 100 },
        cited_ids: { type: 'array', items: { type: 'string' }, description: 'Memory IDs cited — use the cited_memory_ids from snapshot_sources().', minItems: 1 },
        force: { type: 'boolean', description: 'Skip event-driven regeneration gate. Default false.', default: false }
      },
      required: ['topic', 'content', 'cited_ids']
    }
  },
  {
    name: 'get_snapshot',
    annotations: { title: 'Get Snapshot', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: `Read an existing canonical snapshot into context. Fast — no LLM calls.

WHEN TO USE: When you need the current canonical state document for a topic (e.g. architecture, auth, glossary) without generating a new one.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to fetch canonical snapshot for. Either topic or snapshot_id required.' },
        snapshot_id: { type: 'string', description: 'Specific snapshot UUID. Either topic or snapshot_id required.' }
      }
    }
  },
  {
    name: 'accept_snapshot',
    annotations: { title: 'Accept Snapshot', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: `Promote a draft snapshot to canonical. Supersedes the prior canonical for this topic.

If gate blockers exist (conflicts detected, tier downgrade, or first canonical), returns them for review. Pass force: true to approve and promote anyway.`,
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'UUID of the draft snapshot to promote.' },
        force: { type: 'boolean', description: 'Override gate blockers. Default false.', default: false }
      },
      required: ['snapshot_id']
    }
  },
  {
    name: 'recall_memories',
    annotations: {
      title: 'Recall Memories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    _meta: {
      'openai/outputTemplate': 'ui://widgets/recall-v39.html',
      'openai/toolInvocation/invoking': 'Searching your memory vault...',
      'openai/toolInvocation/invoked': 'Memories recalled',
      'openai/widgetAccessible': true,
      'openai/widgetDomain': 'recall.widgets.purmemo.ai'
    },
    description: `Search and retrieve saved memories with intelligent semantic ranking.

🎯 BASIC SEARCH:
  recall_memories(query="authentication")
  → Returns all memories about authentication, ranked by semantic relevance

🔍 FILTERED SEARCH (Phase 2 Knowledge Graph Intelligence):
  Use filters when you need PRECISION over semantic similarity:

  ✓ entity="name" - Find memories mentioning specific people/projects/technologies
    Example: entity="purmemo" → Only memories discussing purmemo

  ✓ has_observations=true - Find substantial, fact-dense conversations
    Example: has_observations=true → Only high-quality technical discussions

  ✓ initiative="project" - Scope to specific initiatives/goals
    Example: initiative="Q1 OKRs" → Only Q1-related memories

  ✓ intent="type" - Filter by conversation purpose
    Options: decision, learning, question, blocker
    Example: intent="blocker" → Only conversations about blockers

💡 WHEN TO FILTER:
  - Use entity when user asks about specific person/project by name
  - Use has_observations for "detailed" or "substantial" requests
  - Use initiative/stakeholder for project-specific searches
  - Use intent when user asks for decisions, learnings, or blockers

📝 COMBINED EXAMPLES:
  recall_memories(query="auth", entity="purmemo", has_observations=true)
  → Find detailed technical discussions about purmemo authentication

  recall_memories(query="blockers", intent="blocker", stakeholder="Engineering")
  → Find engineering team blockers`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - can be keywords, topics, or specific content'
        },
        includeChunked: {
          type: 'boolean',
          default: true,
          description: 'Include chunked/multi-part conversations in results'
        },
        limit: {
          type: 'integer',
          default: 10,
          description: 'Maximum number of memories to return'
        },
        entity: {
          type: 'string',
          description: 'Filter by entity name (people, projects, technologies). Use when user asks about a specific person, project, or technology by name. Example: entity="Alice" finds only memories mentioning Alice. More precise than semantic search. Supports partial matching.'
        },
        initiative: {
          type: 'string',
          description: 'Filter by initiative/project name from conversation context. Use when user scopes search to specific project or goal. Example: initiative="Q1 OKRs" finds only Q1-related memories. Supports partial matching (ILIKE).'
        },
        stakeholder: {
          type: 'string',
          description: "Filter by stakeholder (person or team) from conversation context. Use when user asks about specific person's or team's involvement. Example: stakeholder=\"Engineering Team\" finds memories where Engineering Team was mentioned as stakeholder. Supports partial matching (ILIKE)."
        },
        deadline: {
          type: 'string',
          description: 'Filter by deadline date from conversation context (YYYY-MM-DD format). Use when user asks about time-sensitive memories or specific deadlines. Example: deadline="2025-03-31" finds memories with March 31, 2025 deadline. Exact match only.'
        },
        intent: {
          type: 'string',
          description: 'Filter by conversation intent/purpose. Options: "decision" (decisions made), "learning" (knowledge gained), "question" (open questions), "blocker" (obstacles/issues). Use when user asks specifically for one of these types. Example: intent="decision" finds only conversations where decisions were made. Exact match only.'
        },
        has_observations: {
          type: 'boolean',
          description: 'Filter by conversation quality based on extracted observations (atomic facts). Set to true to find substantial, structured conversations with extracted knowledge (high-quality technical discussions, detailed planning). Set to false for lightweight chats. Omit to return all memories regardless of observation count. Use when user asks for "detailed", "substantial", or "in-depth" information.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_memory_details',
    annotations: {
      title: 'Get Memory Details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    _meta: {
      'openai/outputTemplate': 'ui://widgets/memory-detail.html',
      'openai/toolInvocation/invoking': 'Loading memory...',
      'openai/toolInvocation/invoked': 'Memory loaded',
      'openai/widgetAccessible': true,
      'openai/widgetDomain': 'detail.widgets.purmemo.ai'
    },
    description: 'Get complete details of a specific memory, including all linked parts if chunked',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          description: 'UUID of the memory to retrieve, OR an ordinal number ("1", "2", etc.) referencing the position from the last recall_memories result'
        },
        includeLinkedParts: {
          type: 'boolean',
          default: true,
          description: 'Include all linked parts if this is a chunked memory'
        },
        offset: {
          type: 'integer',
          default: 0,
          description: 'Character offset for paginated retrieval of large memories. When a response says "use offset: N to continue", pass that value here to get the next page.'
        },
        maxChars: {
          type: 'integer',
          default: 80000,
          description: 'Maximum characters per page (default 80000, min 1000, max 500000). Reduce for faster responses on slow connections.'
        }
      },
      required: ['memoryId']
    }
  },
  {
    name: 'discover_related_conversations',
    annotations: {
      title: 'Discover Related Conversations',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    _meta: {
      'openai/outputTemplate': 'ui://widgets/discover.html',
      'openai/toolInvocation/invoking': 'Finding related memories across platforms...',
      'openai/toolInvocation/invoked': 'Connections found',
      'openai/widgetAccessible': true,
      'openai/widgetDomain': 'discover.widgets.purmemo.ai'
    },
    description: `CROSS-PLATFORM DISCOVERY: Find related conversations across ALL AI platforms.

    Uses Purmemo's semantic clustering to automatically discover conversations about similar topics,
    regardless of which AI platform was used (ChatGPT, Claude Desktop, Gemini, etc).

    WHAT THIS DOES:
    - Searches for memories matching your query
    - Uses AI-organized semantic clusters to find related conversations
    - Groups results by topic cluster with platform indicators
    - Shows conversations you may have forgotten about on other platforms

    EXAMPLES:
    User: "Show me all conversations about the marketing project"
    → Finds conversations across ChatGPT, Claude, Gemini automatically

    User: "What have I discussed about licensing requirements?"
    → Discovers related discussions from all platforms, grouped by semantic similarity

    User: "Find everything about React hooks"
    → Returns conversations from any platform where you discussed React hooks

    RESPONSE FORMAT:
    Shows memories grouped by semantic cluster with platform badges (ChatGPT, Claude, Gemini)
    Each cluster represents conversations about similar topics across all platforms`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query for discovering related conversations across platforms'
        },
        limit: {
          type: 'integer',
          default: 10,
          description: 'Maximum number of initial search results (will find related for each)'
        },
        relatedPerMemory: {
          type: 'integer',
          default: 5,
          description: 'Maximum related conversations to find per result'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_user_context',
    annotations: {
      title: 'Get User Context',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    _meta: {
      'openai/outputTemplate': 'ui://widgets/context.html',
      'openai/toolInvocation/invoking': 'Loading your context...',
      'openai/toolInvocation/invoked': 'Context ready',
      'openai/widgetAccessible': true,
      'openai/widgetDomain': 'context.widgets.purmemo.ai'
    },
    description: `Get the current user's cognitive identity and active session context.

Call this at the START of a conversation to understand who you're talking to —
their role, expertise, current project, and recent memory themes.

This is the core of Purmemo's identity layer: once set in the dashboard,
your identity travels silently to every AI session so you're never explaining
yourself from scratch again.

WHAT IT RETURNS:
- identity: role, expertise areas, primary domain, work style, preferred tools
- current_session: what the user is working on right now (project, focus)
- memory_summary: 2-3 sentence synthesis of the user's most recent memory themes

WHEN TO CALL:
- At the start of every new session (add to Claude system prompt)
- When user says "load my context" or "what do you know about me?"
- Before making recommendations that depend on knowing the user's background

EXAMPLE USAGE:
→ User starts new Claude session
→ Claude calls get_user_context automatically
→ Response: { role: "founder", expertise: ["product", "fullstack"],
              project: "purmemo", focus: "identity layer",
              memory_summary: "Chris has been building Purmemo's..." }
→ Claude responds with full context already loaded — no re-explaining needed`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  // ============================================================================
  // WORKFLOW ENGINE TOOLS
  // ============================================================================
  {
    name: 'run_workflow',
    annotations: {
      title: 'Run Workflow',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Run a Purmemo workflow — structured, memory-powered processes for product, engineering, business, and operations tasks. Your relevant memories and identity are automatically loaded to personalize every workflow.

WHEN TO USE THIS TOOL:
- User wants to write a PRD, debug an issue, plan a sprint, review code, or any structured task
- User describes a goal but doesn't know the exact process ("I want to ship a feature")
- User asks for strategic advice, design guidance, or operational help
- User says "help me", "guide me", "walk me through", or describes a business/product/engineering need

AVAILABLE WORKFLOWS (pass the workflow name, or describe what you need):
  Product:     prd, roadmap, story, design, feedback
  Strategy:    ceo, growth, metrics, intel
  Engineering: debug, review, deploy, incident
  Operations:  sprint
  Content:     copy

EXAMPLES:
  run_workflow(workflow="prd", input="notification system for mobile app")
  run_workflow(workflow="debug", input="TypeError: Cannot read property 'map' of undefined in Timeline")
  run_workflow(input="production is down, users can't save memories") → auto-routes to incident
  run_workflow(input="what should I focus on this week?") → auto-routes to sprint
  run_workflow(input="how's the business doing?") → auto-routes to metrics

DO NOT use this tool for: simple memory recall (use recall_memories), saving conversations (use save_conversation), or finding related discussions (use discover_related_conversations).

If no specific workflow is named, the system auto-routes based on the user's intent.`,
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          description: 'Workflow name (e.g., "prd", "debug", "sprint"). Use list_workflows to see all available options including custom workflows. Optional — if omitted, auto-routes from input.'
        },
        input: {
          type: 'string',
          description: 'What you want to accomplish, the problem to solve, or context for the workflow.'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'list_workflows',
    annotations: {
      title: 'List Available Workflows',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: `List all available Purmemo workflows — structured, memory-powered processes you can run.

WHEN TO USE THIS TOOL:
- User asks "what can you help me with?" or "what workflows do you have?"
- User wants to see available capabilities before choosing one
- User says "show me what's available" or "list workflows"

Returns the full catalog of workflows organized by category with descriptions.`,
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['product', 'strategy', 'engineering', 'business', 'operations', 'content'],
          description: 'Optional filter by category. Omit to see all workflows.'
        }
      },
      required: []
    }
  },
  // Sharing & Community tools (Migration 068)
  {
    name: 'share_memory',
    annotations: {
      title: 'Share Memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Set the visibility of a memory you own.

VISIBILITY LEVELS:
- private: Only you can see it (default)
- unlisted: Anyone with the direct link can view it
- public: Discoverable in the community tab by all users

WHEN TO USE:
- User says "share this memory" or "make this public"
- User wants to share knowledge with the community
- User wants to generate a shareable link

QUOTA:
- Free tier: 5 shares/month
- Pro/Teams: Unlimited

EXAMPLE:
share_memory({ memory_id: "abc-123", visibility: "public" })

RETURNS: Updated visibility status and confirmation message.`,
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'UUID of the memory to share'
        },
        visibility: {
          type: 'string',
          enum: ['private', 'unlisted', 'public'],
          description: 'Target visibility level'
        }
      },
      required: ['memory_id', 'visibility']
    }
  },
  {
    name: 'recall_public',
    annotations: {
      title: 'Search Public Memories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Search public memories shared by all Purmemo users. This is the community knowledge base.

WHEN TO USE:
- User asks "what have other people saved about X?"
- User wants to explore community knowledge
- User asks to search public/shared memories
- Looking for solutions others have found

DOES NOT COUNT AGAINST RECALL QUOTA — public knowledge is free.

FILTERS:
- query: Semantic search query (uses vector similarity)
- tag: Filter by tag
- platform: Filter by source platform
- sort: "recent" or "popular" (by recall count)

EXAMPLE:
recall_public({ query: "MCP server testing best practices" })

RETURNS: List of public memories with author attribution, relevance scores, and recall counts.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for semantic search across public memories'
        },
        tag: {
          type: 'string',
          description: 'Filter by tag'
        },
        platform: {
          type: 'string',
          description: 'Filter by source platform (chatgpt, claude, gemini, etc.)'
        },
        sort: {
          type: 'string',
          enum: ['recent', 'popular'],
          description: 'Sort order: recent (newest first) or popular (most recalled first)'
        },
        page: {
          type: 'number',
          description: 'Page number (default 1)'
        }
      },
      required: []
    }
  },
  {
    name: 'get_public_memory',
    annotations: {
      title: 'Get Full Public Memory',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Retrieve the FULL content of a public or unlisted memory by ID.

WHEN TO USE:
- After recall_public returns a preview and you need the complete content
- When a user wants to read or implement from a shared community memory
- When you have a public memory ID and need the full text

This is the tool that closes the loop: recall_public finds memories, this tool retrieves them in full.
No authentication required — public knowledge is free.

EXAMPLE:
get_public_memory({ memory_id: "abc-123-def-456" })

RETURNS: Full memory content, observations, entities, tags, author attribution, and metadata.`,
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'UUID of the public memory to retrieve in full'
        }
      },
      required: ['memory_id']
    }
  },
  {
    name: 'report_memory',
    annotations: {
      title: 'Report Public Memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Report a public memory for inappropriate content.

WHEN TO USE:
- User encounters spam, misleading, or inappropriate public content
- User wants to flag content that contains personal information

REASONS: spam, inappropriate, misleading, personal_info, other

After 3 reports, a memory is automatically hidden from public view pending admin review.

EXAMPLE:
report_memory({ memory_id: "abc-123", reason: "spam", description: "Promotional content" })`,
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'UUID of the public memory to report'
        },
        reason: {
          type: 'string',
          enum: ['spam', 'inappropriate', 'misleading', 'personal_info', 'other'],
          description: 'Reason for reporting'
        },
        description: {
          type: 'string',
          description: 'Optional additional details about the report'
        }
      },
      required: ['memory_id', 'reason']
    }
  },
  // Admin-only tools — always registered, access guarded in handler
  {
    name: 'get_acknowledged_errors',
    annotations: {
      title: 'Get Acknowledged Errors',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Fetch open and acknowledged errors waiting for AI investigation.

    Returns errors with status 'open' or 'acknowledged' — all errors needing
    attention. Each error includes recent_occurrences[] with per-request context
    (user_id, path, method) for investigation.

    USAGE:
    - Call this when user says "investigate errors" or "/investigate-errors"
    - Errors are sorted by occurrence count (most frequent first)
    - Each result includes recent_occurrences[] for per-request investigation context

    QUERY PARAMETERS:
    - limit: Max errors to return (default: 10)
    - level_filter: Filter by level - 'all', 'critical', 'error', 'warning' (default: 'all')
    - min_occurrences: Only errors with occurrence_count >= this (default: 1)

    EXAMPLE:
    get_acknowledged_errors(limit=5, level_filter="error", min_occurrences=3)
    → Returns top 5 error-level issues that occurred 3+ times

    RETURNS:
    - acknowledged_errors: Array of error objects (open + acknowledged)
    - total_count: Number of errors returned
    - filters_applied: Summary of filters used`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          default: 10,
          description: 'Maximum number of errors to return'
        },
        level_filter: {
          type: 'string',
          default: 'all',
          enum: ['all', 'critical', 'error', 'warning'],
          description: 'Filter by error level'
        },
        min_occurrences: {
          type: 'integer',
          default: 1,
          description: 'Only errors with occurrence_count >= this'
        }
      },
      required: []
    }
  },
  {
    name: 'save_investigation_result',
    annotations: {
      title: 'Save Investigation Result',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: `Save AI investigation results for an error incident.

    Used to store investigation results for audit trail and learning from past fixes.
    Call this after investigating an error and proposing/deploying a fix.

    USAGE:
    - Call after completing investigation and deploying fix
    - Stores root cause analysis, research sources, proposed changes
    - Creates audit trail for learning from past investigations

    REQUEST FIELDS:
    - incident_id: UUID of the error incident (from get_acknowledged_errors)
    - root_cause_analysis: Your analysis of what caused the error
    - similar_incidents_analyzed: Array of similar incident IDs found
    - research_sources: Array of URLs used (search_web_ai, Context7 docs)
    - fix_type: Type of fix - 'code_change', 'config_update', 'deployment', 'migration', 'documentation'
    - proposed_changes: Object with file paths and changes made
    - confidence_score: Your confidence in the fix (0.0-1.0)
    - risk_level: Risk assessment - 'low', 'medium', 'high'
    - test_plan: How you tested the fix
    - rollback_plan: How to roll back if needed
    - deployment_commit_hash: Git commit hash of the fix
    - deployment_results: Object with deployment success/failure details

    EXAMPLE:
    save_investigation_result({
      incident_id: "550e8400-e29b-41d4-a716-446655440000",
      root_cause_analysis: "Timeout set to 5s, too short for slow networks",
      fix_type: "code_change",
      confidence_score: 0.85,
      risk_level: "low",
      deployment_commit_hash: "abc123def456"
    })

    RETURNS:
    - investigation_id: UUID of saved investigation
    - incident_id: UUID of the error incident
    - investigation_status: 'in_progress' or 'completed'
    - deployment_status: 'not_started', 'in_progress', 'completed'
    - success: true if saved successfully`,
    inputSchema: {
      type: 'object',
      properties: {
        incident_id: {
          type: 'string',
          description: 'UUID of the error incident from get_acknowledged_errors'
        },
        root_cause_analysis: {
          type: 'string',
          description: 'Your analysis of what caused the error'
        },
        similar_incidents_analyzed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of similar incident IDs found via recall_memories'
        },
        research_sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              source: { type: 'string' }
            }
          },
          description: 'Array of research sources used (URLs from search_web_ai, Context7)'
        },
        fix_type: {
          type: 'string',
          enum: ['code_change', 'config_update', 'deployment', 'migration', 'documentation'],
          description: 'Type of fix applied'
        },
        proposed_changes: {
          type: 'object',
          description: 'Object with file paths and changes made'
        },
        confidence_score: {
          type: 'number',
          minimum: 0.0,
          maximum: 1.0,
          description: 'AI confidence in proposed fix (0.0-1.0)'
        },
        risk_level: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Risk assessment of the fix'
        },
        test_plan: {
          type: 'string',
          description: 'How the fix was tested'
        },
        rollback_plan: {
          type: 'string',
          description: 'How to roll back if fix fails'
        },
        deployment_commit_hash: {
          type: 'string',
          description: 'Git commit hash of the deployed fix'
        },
        deployment_results: {
          type: 'object',
          description: 'Deployment success/failure details'
        }
      },
      required: ['incident_id']
    }
  },
  {
    name: 'generate_handoff_brief',
    annotations: {
      title: 'Generate Handoff Brief',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Generate a surgical context brief for a new AI session. Instead of re-explaining your context, the AI already knows where you left off.

Uses a 5-layer compaction hierarchy to maximize signal in ~2,000 tokens:
1. Intent — What you were trying to accomplish (never cut)
2. Decisions — What was decided and completed
3. Open Loops — Blockers, unresolved items, active todos
4. Context — Technologies, entities, project details
5. Content — Brief excerpts (trimmed to fit budget)

Call this at the start of a new session or when switching projects to give the AI instant context.
No new data is generated — composes from your existing V2 intelligence extraction data.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Optional: filter brief to a specific project. If omitted, uses all recent activity.'
        },
        token_budget: {
          type: 'number',
          description: 'Optional: approximate token budget for the brief (default ~2000 tokens). Range: 500-5000.',
          minimum: 500,
          maximum: 5000,
          default: 2000
        }
      },
      required: []
    }
  },
  {
    name: 'save_test_result',
    annotations: {
      title: 'Save Test Result',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    description: `Save a test result memory for a project, linked to the current active task.

Call this after running tests — pass or fail — to record the outcome.
Saves a memory with category='test_result' and links it to the most recent active task.
Re-running with the same test_suite name updates the existing memory (living document).

USAGE:
- After a passing test run: save_test_result({ project_name, passed: true, test_suite })
- After a failing run: save_test_result({ ..., passed: false, failure_details: "..." })

RETURNS:
- memory_id — UUID of the saved test result memory
- status — "PASSED" or "FAILED"
- linked_task — the active task this result is associated with (if any)`,
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'The project name (e.g. "purmemo")'
        },
        passed: {
          type: 'boolean',
          description: 'Whether the test suite passed'
        },
        test_suite: {
          type: 'string',
          description: 'Name of the test suite (e.g. "get_next_task e2e")'
        },
        failure_details: {
          type: 'string',
          description: 'Details about what failed — only include when passed=false'
        }
      },
      required: ['project_name', 'passed', 'test_suite']
    }
  },
  {
    name: 'get_next_task',
    annotations: {
      title: 'Get Next Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: `Get the next pending task for a project and mark it active.

Fetches the lowest-sequence pending task from the project_tasks queue, sets its status to 'active',
and returns the task details plus a brief from the linked PRD memory.

NOTE: project_tasks is a structured work queue — separate from recall_memories todos.
Tasks are created explicitly via the task management workflow, not auto-populated from
saved conversations. If this returns "no pending tasks", the project queue is empty —
use recall_memories to find work items in saved conversations instead.

Call this at the start of a work session to pick up where you left off.
When done, call complete_task({ task_id, verification_summary }) to close the loop.

RETURNS:
- task.id — use this in complete_task
- task.sequence — task order number
- task.title — what to do
- task.description — how to do it
- task.acceptance_criteria — how to know it's done
- task.context_brief — first 500 chars of the PRD for context
- task.total_remaining — pending tasks left (including this one)`,
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'The project name to fetch the next task for (e.g. "purmemo")'
        }
      },
      required: ['project_name']
    }
  },
  {
    name: 'complete_task',
    annotations: {
      title: 'Complete Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: `Mark a project task as done and close the Jered Loop for this session.

Sets status='done', records completion_summary, clears active_session_id.
Returns the next pending task so you know what comes next before closing.

Call this BEFORE ending a session — Jered's rule: consciously close each task.

RETURNS:
- completed — the task that was just finished
- next_task — { id, sequence, title } of next pending task, or null if all done
- message — "Task complete. N tasks remaining." or "Task complete. All tasks done!"`,
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'The project name (e.g. "purmemo")'
        },
        task_id: {
          type: 'string',
          description: 'The task UUID from get_next_task'
        },
        verification_summary: {
          type: 'string',
          description: 'What was done and verified — used as completion_summary on the task'
        }
      },
      required: ['project_name', 'task_id', 'verification_summary']
    }
  }
];

const server = new Server(
  { name: 'purmemo-mcp', version: CLIENT_VERSION },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: `Purmemo is a cross-platform AI conversation memory system. Use these tools to save, search, and discover conversations across ChatGPT, Claude, Gemini, and other platforms.

CORE WORKFLOW:
1. save_conversation — Save COMPLETE conversations as memory. Same title (or conversationId) targets the existing memory. The 'mode' parameter controls update behavior: mode='replace' (default) overwrites; mode='append' concatenates with a timestamped separator. The /save skill sets mode='append' automatically. Include every message verbatim (minimum 500 chars, expect thousands). Server auto-chunks content >15K chars and forwards mode to each chunk.
2. recall_memories — Search memories with semantic ranking. Use Phase 2 filters (entity, has_observations, initiative, intent) for precision. Default hybrid search covers most cases.
3. get_memory_details — Retrieve full memory content including all linked chunks for multi-part conversations.
4. discover_related_conversations — Find related conversations across ALL AI platforms using semantic clustering.

KEY PATTERNS:
- Update semantics: Same title = targets the existing memory. mode='replace' overwrites; mode='append' adds a timestamped section below prior content. Pick based on whether you want history visible inline.
- Cross-Platform: Memories span ChatGPT, Claude, Gemini, Cursor — discover_related_conversations finds connections across all platforms.
- Intelligent Extraction: save_conversation auto-extracts project context, technologies, status, and generates smart titles.
- Quality Filtering: Use has_observations=true to find substantial technical discussions; entity="name" for specific topics.

COMMUNITY & SHARING:
5. share_memory — Make a memory public or unlisted. Public memories appear in the community tab.
6. recall_public — Search public memories from ALL users. Free for all tiers — does not count against quota.
7. report_memory — Flag inappropriate public content. 3+ reports auto-hides until admin review.

WORKFLOWS:
8. run_workflow — Run memory-powered workflows (PRD, debug, sprint, growth, etc). Describe what you need or name a specific workflow. Memories and identity are pre-loaded automatically.
9. list_workflows — See all available workflows organized by category.

BEST PRACTICES:
- Always send complete conversation content when saving — never summaries or partial content.
- Use recall_memories before saving to check if a living document already exists for the topic.
- For "save progress" requests, the system auto-generates contextual titles from conversation content.
- When users describe a structured task (writing PRDs, debugging, planning sprints, strategic analysis), use run_workflow instead of handling it generically.`
  }
);

// ============================================================================
// TIER 4: Resource Definitions (MCP 2025-11-25)
// ============================================================================

const RESOURCES = [
  {
    uri: 'memory://me',
    name: 'Who I Am',
    description: 'Your cognitive fingerprint — role, expertise, domain, tools, work style, current session, and vault stats. Attach this at the start of any conversation so Claude knows who it\'s talking to without you having to explain yourself.',
    mimeType: 'text/plain'
  },
  {
    uri: 'memory://context',
    name: 'My Recent Work Context',
    description: 'A briefing of your 5 most recent memories — what you\'ve been working on, what decisions were made, what\'s in progress. Attach when starting a work session to skip the "catch me up" step.',
    mimeType: 'text/plain'
  },
  {
    uri: 'memory://projects',
    name: 'My Active Projects',
    description: 'Your active projects grouped by name, showing recent activity per project. Attach when switching between projects or planning what to work on next.',
    mimeType: 'text/plain'
  },
  {
    uri: 'memory://stats',
    name: 'Memory Vault Stats',
    description: 'How many memories you\'ve saved, which platforms they\'re from, and your activity this week.',
    mimeType: 'text/plain'
  },
  // ChatGPT Apps SDK Widgets — rendered as iframes via text/html+skybridge MIME
  {
    uri: 'ui://widgets/recall-v39.html',
    name: 'Recall Widget',
    description: 'Interactive memory recall card list for ChatGPT Apps SDK.',
    mimeType: 'text/html+skybridge',
    _meta: { 'openai/widgetCSP': { connect_domains: [], resource_domains: [] }, 'openai/widgetDomain': 'recall.widgets.purmemo.ai' }
  },
  {
    uri: 'ui://widgets/save.html',
    name: 'Save Widget',
    description: 'Save confirmation card for ChatGPT Apps SDK.',
    mimeType: 'text/html+skybridge',
    _meta: { 'openai/widgetCSP': { connect_domains: [], resource_domains: [] }, 'openai/widgetDomain': 'save.widgets.purmemo.ai' }
  },
  {
    uri: 'ui://widgets/memory-detail.html',
    name: 'Memory Detail Widget',
    description: 'Full memory content viewer for ChatGPT Apps SDK.',
    mimeType: 'text/html+skybridge',
    _meta: { 'openai/widgetCSP': { connect_domains: [], resource_domains: [] }, 'openai/widgetDomain': 'detail.widgets.purmemo.ai' }
  },
  {
    uri: 'ui://widgets/context.html',
    name: 'Context Widget',
    description: 'User context and stats display for ChatGPT Apps SDK.',
    mimeType: 'text/html+skybridge',
    _meta: { 'openai/widgetCSP': { connect_domains: [], resource_domains: [] }, 'openai/widgetDomain': 'context.widgets.purmemo.ai' }
  },
  {
    uri: 'ui://widgets/discover.html',
    name: 'Discover Widget',
    description: 'Cross-platform conversation discovery for ChatGPT Apps SDK.',
    mimeType: 'text/html+skybridge',
    _meta: { 'openai/widgetCSP': { connect_domains: [], resource_domains: [] }, 'openai/widgetDomain': 'discover.widgets.purmemo.ai' }
  }
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'memory://{memoryId}',
    name: 'Specific Memory',
    description: 'Retrieve full content of a specific memory by its unique ID',
    mimeType: 'application/json'
  }
];

// ============================================================================
// TIER 4: Prompt Definitions (MCP 2025-11-25)
// ============================================================================

const PROMPTS = [
  {
    name: 'load-context',
    description: 'Load relevant memory context before starting work. Searches your vault for past conversations, decisions, and patterns related to what you\'re about to do.',
    arguments: [
      {
        name: 'topic',
        description: 'What you\'re about to work on (optional — omit to load general recent context)',
        required: false
      }
    ]
  },
  {
    name: 'save-this-conversation',
    description: 'Save this conversation to your memory vault as a living document. Updates an existing memory if the same topic was saved before.',
    arguments: [
      {
        name: 'note',
        description: 'Optional note about what was most important in this conversation',
        required: false
      }
    ]
  },
  {
    name: 'catch-me-up',
    description: 'Catch me up on a project — what\'s been done, what decisions were made, what\'s next.',
    arguments: [
      {
        name: 'project',
        description: 'Project name to summarize',
        required: true
      }
    ]
  },
  {
    name: 'weekly-review',
    description: 'What have I been working on this week? Summarizes recent memory activity across all projects and platforms.',
    arguments: []
  }
];

// Tool handlers extracted to ./tools/handlers.ts

// Setup server
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Prepend update notice to a tool result if one is set
function withUpdateNotice(result) {
  if (!_updateNotice || !result?.content?.length) return result;
  return {
    ...result,
    content: [{ type: 'text', text: _updateNotice }, ...result.content]
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Track tool usage (for remote mode health endpoint)
  if (typeof toolCallCounts !== 'undefined') {
    toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;
  }

  switch (name) {
    case 'save_conversation':
      return withUpdateNotice(await handleSaveConversation(args));
    case 'save_artifact':
      return withUpdateNotice(await handleSaveArtifact(args));
    case 'commit':
      return withUpdateNotice(await handleCommit(args));
    case 'snapshot':
      return withUpdateNotice(await handleSnapshot(args));
    case 'snapshot_sources':
      return withUpdateNotice(await handleSnapshotSources(args));
    case 'save_snapshot':
      return withUpdateNotice(await handleSaveSnapshot(args));
    case 'get_snapshot':
      return withUpdateNotice(await handleGetSnapshot(args));
    case 'accept_snapshot':
      return withUpdateNotice(await handleAcceptSnapshot(args));
    case 'recall_memories':
      return withUpdateNotice(await handleRecallMemories(args));
    case 'get_memory_details':
      return withUpdateNotice(await handleGetMemoryDetails(args));
    case 'discover_related_conversations':
      return withUpdateNotice(await handleDiscoverRelated(args));
    case 'get_user_context':
      return withUpdateNotice(await handleGetUserContext(args));
    case 'run_workflow':
      return withUpdateNotice(await handleRunWorkflow(args));
    case 'list_workflows':
      return withUpdateNotice(await handleListWorkflows(args));
    case 'share_memory':
      return withUpdateNotice(await handleShareMemory(args));
    case 'recall_public':
      return withUpdateNotice(await handleRecallPublic(args));
    case 'get_public_memory':
      return withUpdateNotice(await handleGetPublicMemory(args));
    case 'report_memory':
      return withUpdateNotice(await handleReportMemory(args));
    case 'get_acknowledged_errors':
      if (!ADMIN_MODE) return { content: [{ type: 'text', text: '❌ Admin access required. Set PURMEMO_ADMIN=1 and provide a valid admin API key.' }] };
      return withUpdateNotice(await handleGetAcknowledgedErrors(args));
    case 'save_investigation_result':
      if (!ADMIN_MODE) return { content: [{ type: 'text', text: '❌ Admin access required. Set PURMEMO_ADMIN=1 and provide a valid admin API key.' }] };
      return withUpdateNotice(await handleSaveInvestigation(args));
    case 'generate_handoff_brief':
      return withUpdateNotice(await handleGenerateHandoffBrief(args));
    case 'save_test_result':
      return withUpdateNotice(await handleSaveTestResult(args));
    case 'get_next_task':
      return withUpdateNotice(await handleGetNextTask(args));
    case 'complete_task':
      return withUpdateNotice(await handleCompleteTask(args));
    default:
      return {
        content: [{
          type: 'text',
          text: `❌ Unknown tool: ${name}`
        }]
      };
  }
});

// ============================================================================
// TIER 4: Resource Handlers (MCP 2025-11-25)
// ============================================================================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  structuredLog.info('resources/list called');
  return {
    resources: RESOURCES,
    resourceTemplates: RESOURCE_TEMPLATES
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const requestId = `resource_read_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = Date.now();

  structuredLog.info('resources/read called', { request_id: requestId, uri });

  try {
    let data;
    let resourceUri = uri;

    if (uri === 'memory://me') {
      // Cognitive fingerprint — identity + session + vault stats + recent work
      const [meResp, statsResp, memoriesResp, sessionResp] = await Promise.allSettled([
        makeApiCall('/api/v1/auth/me'),
        makeApiCall('/api/v1/stats/'),
        makeApiCall('/api/v1/memories/?limit=20&sort=created_at&order=desc'),
        makeApiCall('/api/v1/identity/session'),
      ]);

      const me = meResp.status === 'fulfilled' ? meResp.value : null;
      if (!me) throw new Error('Unable to load profile.');

      const identity = me.identity || {};
      const email = me.email || '';
      const name = me.full_name || email.split('@')[0] || 'You';
      const sessionData = sessionResp.status === 'fulfilled' ? (sessionResp.value.session || {}) : {};

      const lines = [`## About Me — ${name}\n`];
      if (identity.role) lines.push(`**Role:** ${identity.role.charAt(0).toUpperCase() + identity.role.slice(1)}`);
      if (identity.primary_domain) lines.push(`**Domain:** ${identity.primary_domain}`);
      if (identity.expertise && identity.expertise.length) lines.push(`**Expertise:** ${identity.expertise.join(', ')}`);
      if (identity.tools && identity.tools.length) lines.push(`**Tools I use:** ${identity.tools.join(', ')}`);
      if (identity.work_style) lines.push(`**Work style:** ${identity.work_style}`);
      if (sessionData.context) lines.push(`**Working on:** ${sessionData.context}`);

      if (statsResp.status === 'fulfilled') {
        const stats = statsResp.value;
        const total = stats.total_memories || 0;
        const thisWeek = stats.memories_this_week || 0;
        const platforms = (stats.platforms || []).filter(p => p && !['user', 'purmemo-web'].includes(p.toLowerCase()) && !p.includes(' '));
        lines.push(`\n**Memory vault:** ${total.toLocaleString()} memories across ${platforms.slice(0, 6).join(', ')}`);
        lines.push(`**This week:** ${thisWeek} memories saved`);
      }

      // Frequency-weighted recent work — projects with ≥2 occurrences only
      if (memoriesResp.status === 'fulfilled') {
        const mems = Array.isArray(memoriesResp.value) ? memoriesResp.value : (memoriesResp.value.memories || []);
        const projectCounts = {};
        for (const m of mems) {
          const proj = (m.project_name || '').trim();
          if (proj) projectCounts[proj] = (projectCounts[proj] || 0) + 1;
        }
        const ranked = Object.entries(projectCounts)
          .filter(([, c]) => c >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        if (ranked.length > 0) {
          lines.push(`\n**Recent work:** ${ranked.map(([p, c]) => `${p} (${c} recent)`).join('; ')}`);
        }
      }

      return {
        contents: [{ uri: resourceUri, mimeType: 'text/plain', text: lines.join('\n') }]
      };

    } else if (uri === 'memory://context') {
      // 5 most recent memories as a human-readable briefing
      data = await makeApiCall('/api/v1/memories/?limit=5&sort=created_at&order=desc');
      const mems = Array.isArray(data) ? data : (data.memories || []);
      const skipPrefixes = ['===', '[', 'USER:', 'ASSISTANT:', 'user:', 'assistant:', '# ', '## '];
      const lines = ['## My Recent Work Context\n'];
      for (const m of mems) {
        if (!m.title) continue;
        lines.push(`### ${m.title}`);
        if (m.project_name) lines.push(`Project: ${m.project_name}`);
        if (m.platform) lines.push(`Platform: ${m.platform}`);
        if (m.content) {
          const preview = m.content.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 20 && !skipPrefixes.some(p => l.startsWith(p)))
            .slice(0, 3)
            .join(' ');
          if (preview) lines.push(preview);
        }
        lines.push('');
      }

      return {
        contents: [{ uri: resourceUri, mimeType: 'text/plain', text: lines.join('\n') }]
      };

    } else if (uri === 'memory://projects') {
      // Active projects grouped by name, sorted by most recent activity
      data = await makeApiCall('/api/v1/memories/?limit=20&sort=created_at&order=desc');
      const mems = Array.isArray(data) ? data : (data.memories || []);
      const projectMap = {};
      for (const m of mems) {
        const proj = (m.project_name || '').trim();
        if (!proj) continue;
        if (!projectMap[proj]) projectMap[proj] = { count: 0, latest: null, latestDate: null };
        projectMap[proj].count++;
        if (!projectMap[proj].latest) {
          projectMap[proj].latest = m.title || '';
          projectMap[proj].latestDate = m.created_at || '';
        }
      }
      const sorted = Object.entries(projectMap).sort((a, b) => {
        return new Date(b[1].latestDate || 0) - new Date(a[1].latestDate || 0);
      });
      const lines = ['## My Active Projects\n'];
      for (const [proj, info] of sorted) {
        lines.push(`**${proj}** — ${info.count} recent memories`);
        if (info.latest) lines.push(`  Latest: ${info.latest}`);
        lines.push('');
      }
      if (sorted.length === 0) lines.push('No project-tagged memories found in recent activity.');

      return {
        contents: [{ uri: resourceUri, mimeType: 'text/plain', text: lines.join('\n') }]
      };

    } else if (uri === 'memory://stats') {
      data = await makeApiCall('/api/v1/stats/', { method: 'GET' });
      const total = data.total_memories || 0;
      const thisWeek = data.memories_this_week || 0;
      const platforms = (data.platforms || []).filter(p => p && !['user', 'purmemo-web'].includes(p.toLowerCase()) && !p.includes(' '));
      const text = [
        '## Memory Vault Stats\n',
        `**Total memories:** ${total.toLocaleString()}`,
        `**This week:** ${thisWeek} saved`,
        `**Platforms:** ${platforms.join(', ') || 'none'}`,
      ].join('\n');

      return {
        contents: [{ uri: resourceUri, mimeType: 'text/plain', text }]
      };

    } else if (uri.startsWith('ui://widgets/')) {
      // Serve ChatGPT Apps SDK widget HTML
      const widgetMap = {
        'ui://widgets/recall-v39.html': 'recall.html',
        'ui://widgets/save.html': 'save.html',
        'ui://widgets/memory-detail.html': 'memory-detail.html',
        'ui://widgets/context.html': 'context.html',
        'ui://widgets/discover.html': 'discover.html'
      };
      const fileName = widgetMap[uri];
      if (!fileName) throw new Error(`Unknown widget: ${uri}`);

      const { readFileSync: readFs } = await import('node:fs');
      const { dirname: dn, join: jn } = await import('node:path');
      const { fileURLToPath: fu } = await import('node:url');
      const widgetPath = jn(dn(fu(import.meta.url)), 'remote', 'widgets', fileName);
      const html = readFs(widgetPath, 'utf8');

      return {
        contents: [{ uri: resourceUri, mimeType: 'text/html+skybridge', text: html }]
      };

    } else if (uri.startsWith('memory://')) {
      // Fetch specific memory by ID
      const memoryId = uri.replace('memory://', '');
      if (!memoryId) throw new Error('Memory ID is required in URI: memory://{memoryId}');
      data = await makeApiCall(`/api/v1/memories/${memoryId}/`, { method: 'GET' });

      return {
        contents: [{ uri: resourceUri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }]
      };

    } else {
      throw new Error(`Unknown resource URI: ${uri}`);
    }

  } catch (error) {
    structuredLog.error('resources/read failed', {
      request_id: requestId,
      uri,
      duration_ms: Date.now() - startTime,
      error_message: error.message,
      error_type: error.constructor.name
    });
    throw error;
  }
});

// ============================================================================
// TIER 4: Prompt Handlers (MCP 2025-11-25)
// ============================================================================

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  structuredLog.info('prompts/list called');
  return { prompts: PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;
  const requestId = `prompt_get_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  structuredLog.info('prompts/get called', { request_id: requestId, prompt_name: name });

  if (name === 'load-context') {
    const topic = promptArgs?.topic || '';

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: topic
            ? `Before I start working on "${topic}", please recall relevant past conversations using recall_memories.\n\nSearch for:\n- Previous discussions about "${topic}"\n- Decisions made that might affect this work\n- Code patterns or approaches used before\n- Any blockers or issues encountered in similar tasks\n\nSummarize what you find so I have full context before starting.`
            : `Please load my recent context using recall_memories. Search for my most recent work across all projects and summarize:\n- What I was last working on\n- Any open threads or decisions pending\n- Key patterns or approaches from recent sessions\n\nKeep it brief — just enough for me to pick up where I left off.`
        }
      }]
    };

  } else if (name === 'save-this-conversation') {
    const note = promptArgs?.note || '';

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Please save our current conversation using the save_conversation tool.\n\n` +
                `Instructions:\n` +
                `- Include the COMPLETE conversation content (every message verbatim)\n` +
                `- Include ALL code blocks with full syntax\n` +
                `- Auto-generate an intelligent title from the content (format: Project - Feature - Type)\n` +
                `- Use the same title if this topic was saved before (living document — it will update, not duplicate)\n` +
                `- Tag with relevant project names and technologies\n` +
                (note ? `- Extra note to include: ${note}\n` : '')
        }
      }]
    };

  } else if (name === 'catch-me-up') {
    const project = promptArgs?.project || 'this project';

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Please catch me up on "${project}" using recall_memories.\n\nSearch for all recent conversations about "${project}" and summarize:\n1. What has been built or decided\n2. What is currently in progress\n3. Any open questions or blockers\n4. What the logical next step is\n\nBe specific — reference actual decisions and implementations, not just topics.`
        }
      }]
    };

  } else if (name === 'weekly-review') {
    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Please give me a weekly review of my work using recall_memories.\n\nSearch for conversations from the past 7 days and organize them by:\n1. Projects worked on (with brief status per project)\n2. Key decisions made\n3. Things completed\n4. Open threads / next steps\n5. Which AI tools were used (cross-platform activity)\n\nKeep it scannable — use headers and bullets, not paragraphs.`
        }
      }]
    };

  } else {
    throw new Error(`Unknown prompt: ${name}. Available prompts: ${PROMPTS.map(p => p.name).join(', ')}`);
  }
});

// ============================================================================
// Startup: resolve API key from ~/.purmemo/auth.json (single source of truth)
// ============================================================================

async function resolveApiKey() {
  // The active profile (or legacy auth.json) is the single source of truth —
  // written by `npx purmemo-mcp setup` / `add`. The PURMEMO_API_KEY env var is
  // no longer read here: it was the root cause of cross-account saves when a
  // stale key leaked into another machine's shell environment (ADR-031).
  // ProfileResolver picks the active file: PURMEMO_PROFILE → active pointer →
  // legacy auth.json.
  try {
    const tokenStore = new TokenStore();
    const token = await tokenStore.getToken();
    if (token?.access_token) {
      structuredLog.info('API key resolved from active profile');

      // Loud warning if the user *also* has PURMEMO_API_KEY in their env. We
      // ignore it here (ADR-031) but older hooks / shell scripts may pick it
      // up and act on a stale key. The warning shows up once per startup.
      if (process.env.PURMEMO_API_KEY) {
        structuredLog.warn('PURMEMO_API_KEY is set in env but ignored at runtime — recommend `unset PURMEMO_API_KEY` to avoid stale-key bugs in older tools', {
          adr: 'ADR-031',
          recommended_action: 'unset PURMEMO_API_KEY'
        });
      }

      return token.access_token;
    }
  } catch (err) {
    structuredLog.warn('Could not read active profile', { error: err.message });
  }

  return null;
}

// ============================================================================
// STARTUP — Stdio (default) or Remote HTTP (--remote / PURMEMO_REMOTE=1)
// ============================================================================

const REMOTE_MODE = process.argv.includes('--remote') || process.env.PURMEMO_REMOTE === '1';

if (REMOTE_MODE) {
  const { startRemoteServer } = await import('./remote/start.js');
  await startRemoteServer({
    API_URL,
    CLIENT_VERSION,
    PLATFORM,
    TOOLS,
    RESOURCES,
    RESOURCE_TEMPLATES,
    PROMPTS,
    server,
    getResolvedApiKey: () => resolvedApiKey,
    setResolvedApiKey: (key) => { resolvedApiKey = key; },
    resolveApiKey,
    checkForUpdates
  });

} else {
  // ========================================================================
  // STDIO MODE — Standard local MCP (default for npm/Claude Desktop/Claude Code)
  // ========================================================================

  // If running interactively in a terminal (not piped by an MCP client) and
  // no auth is configured, redirect to setup instead of silently hanging.
  if (process.stdin.isTTY) {
    const _ts = new TokenStore();
    const _tok = await _ts.getToken();
    if (!_tok?.access_token) {
      console.log('\n🧠 pūrmemo MCP — Memory for your AI tools\n');
      console.log('Not connected yet. Run setup to get started:\n');
      console.log('  npx purmemo-mcp setup\n');
      process.exit(0);
    }
  }

  const transport = new StdioServerTransport();

  resolveApiKey().then(apiKey => {
    resolvedApiKey = apiKey;
    return server.connect(transport);
  })
    .then(() => {
      checkForUpdates();
      structuredLog.info('Purmemo MCP Server started successfully', {
        mode: 'stdio',
        version: CLIENT_VERSION,
        tier: '4-resources-prompts',
        api_url: API_URL,
        api_key_configured: !!resolvedApiKey,
        api_key_source: resolvedApiKey ? 'profile' : 'none',
        platform: PLATFORM,
        tools_count: TOOLS.length,
        circuit_breaker_enabled: true,
        request_timeout_ms: 30000,
        features: [
          'Intelligent memory saving with auto-context extraction',
          'Smart title generation (no more timestamps)',
          'Automatic project/component/feature detection',
          'Roadmap tracking across AI tools',
          'Unicode sanitization',
          'Structured JSON logging',
          'Circuit breaker pattern for API resilience',
          'Per-tool request timing and metrics',
          'Safe error handling with fallbacks',
          'MCP Resources (memory://me, memory://context, memory://projects, memory://stats, memory://{id})',
          'MCP Prompts (load-context, save-this-conversation, catch-me-up, weekly-review)',
          'Workflow Engine (run_workflow, list_workflows — 15 memory-powered workflows)'
        ]
      });
    })
    .catch((error) => {
      structuredLog.error('Failed to start MCP server', {
        error_message: error.message,
        error_type: error.constructor.name
      });
      process.exit(1);
    });
}

} // end else (not a subcommand)
