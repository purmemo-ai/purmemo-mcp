// @ts-nocheck — typing deferred (matches handlers.ts convention)
/**
 * Handoff Brief Generator — Moat Month Feature 1
 *
 * Generates a surgical context brief for new AI sessions.
 * Instead of re-explaining context, the AI already knows where you left off.
 *
 * Compaction Hierarchy (from Claude Code's 6-stage cascade):
 *   Layer 1: Intent (highest priority, never cut)
 *   Layer 2: Decisions made
 *   Layer 3: Open loops (blockers, unresolved items)
 *   Layer 4: Project context (technologies, entities)
 *   Layer 5: Conversation content (lowest priority, cut first)
 *
 * Budget: ~2,000 tokens (~8,000 chars). Enough to orient AI, small enough
 * to not waste context window.
 *
 * Uses existing V2 extraction data — no new tables, no new LLM calls.
 */

import { structuredLog } from '../lib/logger.js';
import { makeApiCall, safeErrorMessage } from '../lib/api-client.js';

// ============================================================================
// Constants
// ============================================================================

const TOKEN_BUDGET_CHARS = 8000; // ~2,000 tokens at ~4 chars/token
const MAX_MEMORIES = 8;          // Recent memories to consider
const MAX_TODOS = 10;            // Open work items to include
const MAX_CONTENT_PREVIEW = 400; // Chars of content per memory (Layer 5)

// ============================================================================
// Types
// ============================================================================

interface Memory {
  id: string;
  title: string;
  summary?: string;
  key_result?: string;
  intent?: string;
  task_type?: string;
  project_name?: string;
  project_component?: string;
  feature_name?: string;
  status?: string;
  next_phase_hint?: string;
  primary_intent?: string;
  decisions?: Decision[];
  work_items?: WorkItem[];
  blockers?: Blocker[];
  completions?: Completion[];
  technologies?: string[];
  entities?: Entity[];
  context_structured?: ContextStructured;
  content?: string;
  content_preview?: string;
  created_at?: string;
  updated_at?: string;
  user_updated_at?: string;
}

interface WorkItem {
  text: string;
  type?: string;
  priority?: string;
  owner?: string;
  deadline?: string;
  status?: string;
}

interface Blocker {
  text: string;
  blocked_item?: string;
  blocking_cause?: string;
  severity?: string;
}

interface Completion {
  text: string;
  completed_item?: string;
}

interface Decision {
  text: string;
  rationale?: string;
  alternatives_considered?: string[];
  confidence?: number;
}

interface Entity {
  name: string;
  type?: string;
  mentions?: number;
  context?: string;
}

interface ContextStructured {
  trigger?: string;
  motivation?: string;
  deadline?: string;
  constraints?: string[];
  initiative?: string;
  stakeholders?: string[];
}

interface Todo {
  id: string;
  text: string;
  status: string;
  priority: string;
  projectName?: string;
  sourceType?: string;
  deadline?: string;
  createdAt?: string;
}

// ============================================================================
// Layer Composers
// ============================================================================

/**
 * Layer 1: Intent — What the user was trying to accomplish.
 * Highest priority, never cut.
 */
function composeIntentLayer(memories: Memory[]): string {
  const lines: string[] = [];

  // Most recent memory's intent is primary
  const primary = memories[0];
  if (primary?.primary_intent) {
    lines.push(`**Goal**: ${primary.primary_intent}`);
  }
  if (primary?.summary) {
    lines.push(`**Last session**: ${primary.summary}`);
  }
  if (primary?.intent && primary.intent !== 'other') {
    lines.push(`**Intent**: ${primary.intent}`);
  }
  if (primary?.task_type) {
    lines.push(`**Activity**: ${primary.task_type}`);
  }
  if (primary?.key_result) {
    lines.push(`**Key result**: ${primary.key_result}`);
  }

  // If there's a next phase hint, surface it
  if (primary?.next_phase_hint && primary.next_phase_hint !== 'other') {
    lines.push(`**Next phase**: ${primary.next_phase_hint}`);
  }

  // Summaries from other recent memories (deduped by project)
  const seenProjects = new Set<string>();
  if (primary?.project_name) seenProjects.add(primary.project_name);

  for (let i = 1; i < memories.length && lines.length < 8; i++) {
    const m = memories[i];
    if (!m.summary) continue;
    const proj = m.project_name || '';
    if (proj && seenProjects.has(proj)) continue;
    if (proj) seenProjects.add(proj);
    lines.push(`**Prior**: ${m.summary}`);
  }

  return lines.length > 0
    ? `## Where You Left Off\n${lines.join('\n')}`
    : '';
}

/**
 * Layer 2: Decisions made — What was decided and why.
 * Uses V2.1 decisions[] (with rationale) first, falls back to work_items type=decision.
 */
function composeDecisionsLayer(memories: Memory[]): string {
  const decisions: string[] = [];
  const completions: string[] = [];

  for (const m of memories) {
    // Prefer V2.1 decisions[] (has rationale + alternatives)
    if (m.decisions && m.decisions.length > 0) {
      for (const d of m.decisions) {
        if (decisions.length < 5) {
          const rationale = d.rationale ? ` — ${d.rationale}` : '';
          decisions.push(`- ${d.text}${rationale}`);
        }
      }
    } else if (m.work_items) {
      // Fall back to decision-type work items (pre-V2.1 data)
      for (const item of m.work_items) {
        if (item.type === 'decision' && decisions.length < 5) {
          decisions.push(`- ${item.text}`);
        }
      }
    }
    // Extract completions
    if (m.completions) {
      for (const c of m.completions) {
        if (completions.length < 4) {
          completions.push(`- ${c.text}`);
        }
      }
    }
  }

  const parts: string[] = [];
  if (decisions.length > 0) {
    parts.push(`**Decisions**:\n${decisions.join('\n')}`);
  }
  if (completions.length > 0) {
    parts.push(`**Completed**:\n${completions.join('\n')}`);
  }

  return parts.length > 0
    ? `## Decisions & Progress\n${parts.join('\n\n')}`
    : '';
}

/**
 * Layer 3: Open Loops — Unresolved items, blockers, active todos.
 * Critical for continuity — these are what the user needs to pick up.
 */
function composeOpenLoopsLayer(memories: Memory[], todos: Todo[]): string {
  const blockers: string[] = [];
  const openItems: string[] = [];

  // Blockers from recent memories
  for (const m of memories) {
    if (m.blockers) {
      for (const b of m.blockers) {
        if (blockers.length < 5) {
          const severity = b.severity ? ` [${b.severity}]` : '';
          blockers.push(`- ${b.text}${severity}`);
        }
      }
    }
    // Open work items (not decisions, not done)
    if (m.work_items) {
      for (const item of m.work_items) {
        if (item.type !== 'decision' && item.status !== 'done' && openItems.length < 5) {
          const prio = item.priority ? ` [${item.priority}]` : '';
          openItems.push(`- ${item.text}${prio}`);
        }
      }
    }
  }

  // Active todos (promoted extracted items)
  const activeTodos: string[] = [];
  for (const t of todos) {
    if (t.status !== 'done' && activeTodos.length < 5) {
      const prio = t.priority ? ` [${t.priority}]` : '';
      const proj = t.projectName ? ` (${t.projectName})` : '';
      activeTodos.push(`- ${t.text}${prio}${proj}`);
    }
  }

  const parts: string[] = [];
  if (blockers.length > 0) {
    parts.push(`**Blockers**:\n${blockers.join('\n')}`);
  }
  if (openItems.length > 0) {
    parts.push(`**Open items**:\n${openItems.join('\n')}`);
  }
  if (activeTodos.length > 0) {
    parts.push(`**Active todos**:\n${activeTodos.join('\n')}`);
  }

  return parts.length > 0
    ? `## Open Loops\n${parts.join('\n\n')}`
    : '';
}

/**
 * Layer 4: Project Context — Technologies, entities, project info.
 */
function composeContextLayer(memories: Memory[]): string {
  const techs = new Set<string>();
  const entities = new Map<string, string>(); // name → type
  const projects = new Map<string, string>(); // project → component/feature

  for (const m of memories) {
    if (m.technologies) {
      for (const t of m.technologies) techs.add(t);
    }
    if (m.entities) {
      for (const e of m.entities) {
        if (e.name && !entities.has(e.name)) {
          entities.set(e.name, e.type || 'unknown');
        }
      }
    }
    if (m.project_name) {
      const detail = [m.project_component, m.feature_name].filter(Boolean).join(' / ');
      if (!projects.has(m.project_name)) {
        projects.set(m.project_name, detail);
      }
    }
  }

  const parts: string[] = [];

  if (projects.size > 0) {
    const projectLines = Array.from(projects.entries())
      .slice(0, 3)
      .map(([name, detail]) => detail ? `- ${name}: ${detail}` : `- ${name}`);
    parts.push(`**Projects**: \n${projectLines.join('\n')}`);
  }

  if (techs.size > 0) {
    parts.push(`**Stack**: ${Array.from(techs).slice(0, 10).join(', ')}`);
  }

  // Only include top entities (by mention count or uniqueness)
  if (entities.size > 0) {
    const topEntities = Array.from(entities.entries())
      .filter(([, type]) => type === 'technology' || type === 'concept' || type === 'person')
      .slice(0, 8)
      .map(([name]) => name);
    if (topEntities.length > 0) {
      parts.push(`**Key entities**: ${topEntities.join(', ')}`);
    }
  }

  // Structured context from most recent memory
  const ctx = memories[0]?.context_structured;
  if (ctx) {
    if (ctx.deadline) parts.push(`**Deadline**: ${ctx.deadline}`);
    if (ctx.initiative) parts.push(`**Initiative**: ${ctx.initiative}`);
    if (ctx.constraints?.length) parts.push(`**Constraints**: ${ctx.constraints.join('; ')}`);
  }

  return parts.length > 0
    ? `## Context\n${parts.join('\n')}`
    : '';
}

/**
 * Layer 5: Content — Lowest priority, trimmed to fit budget.
 * Brief excerpts from recent memory content.
 */
function composeContentLayer(memories: Memory[], remainingChars: number): string {
  if (remainingChars < 200) return '';

  const excerpts: string[] = [];
  let used = 0;

  for (const m of memories) {
    if (used >= remainingChars) break;
    const content = (m.content_preview || m.content || '').trim();
    if (!content || content.length < 50) continue;

    const maxLen = Math.min(MAX_CONTENT_PREVIEW, remainingChars - used);
    if (maxLen < 100) break;

    const excerpt = content.slice(0, maxLen);
    const title = m.title || 'Untitled';
    const line = `**${title}**: ${excerpt}${content.length > maxLen ? '…' : ''}`;
    excerpts.push(line);
    used += line.length;
  }

  return excerpts.length > 0
    ? `## Recent Context\n${excerpts.join('\n\n')}`
    : '';
}

// ============================================================================
// Brief Assembly
// ============================================================================

function assembleBrief(memories: Memory[], todos: Todo[], projectFilter?: string): string {
  if (memories.length === 0 && todos.length === 0) {
    return 'No recent activity found. Start a conversation and save it to build your handoff brief.';
  }

  // Filter by project if specified
  const filtered = projectFilter
    ? memories.filter(m => m.project_name?.toLowerCase().includes(projectFilter.toLowerCase()))
    : memories;

  // Fall back to unfiltered if project filter yields nothing
  const source = filtered.length > 0 ? filtered : memories;

  // Compose layers in priority order
  const layer1 = composeIntentLayer(source);
  const layer2 = composeDecisionsLayer(source);
  const layer3 = composeOpenLoopsLayer(source, todos);
  const layer4 = composeContextLayer(source);

  // Calculate remaining budget for Layer 5
  const header = `# Handoff Brief`;
  const usedChars = [header, layer1, layer2, layer3, layer4]
    .filter(Boolean)
    .join('\n\n')
    .length;
  const remaining = TOKEN_BUDGET_CHARS - usedChars - 100; // 100 chars buffer

  const layer5 = composeContentLayer(source, remaining);

  // Assemble — only include non-empty layers
  const sections = [header, layer1, layer2, layer3, layer4, layer5].filter(Boolean);
  let brief = sections.join('\n\n');

  // Hard trim if somehow over budget
  if (brief.length > TOKEN_BUDGET_CHARS) {
    brief = brief.slice(0, TOKEN_BUDGET_CHARS - 3) + '…';
  }

  return brief;
}

// ============================================================================
// Handler
// ============================================================================

export async function handleGenerateHandoffBrief(args: {
  project_name?: string;
  token_budget?: number;
}, apiKey = null) {
  const toolName = 'generate_handoff_brief';
  const requestId = `${toolName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  structuredLog.info(`${toolName}: starting`, {
    tool_name: toolName,
    request_id: requestId,
    project_name: args.project_name || '(all)',
  });

  try {
    // Fetch recent memories and active todos in parallel
    const memoriesParams = new URLSearchParams({
      limit: String(MAX_MEMORIES),
      sort: 'user_updated_at',
      order: 'desc',
    });

    const [memoriesResponse, todosResponse] = await Promise.allSettled([
      makeApiCall(`/api/v1/memories/?${memoriesParams}`, { method: 'GET' }),
      makeApiCall('/api/v1/todos?limit=' + MAX_TODOS, { method: 'GET' }),
    ]);

    // Parse memories
    let memories: Memory[] = [];
    if (memoriesResponse.status === 'fulfilled') {
      const data = memoriesResponse.value;
      const raw = Array.isArray(data) ? data : (data.memories || []);
      memories = raw as Memory[];
      structuredLog.debug(`${toolName}: loaded ${memories.length} memories`, { request_id: requestId });
    } else {
      structuredLog.warn(`${toolName}: memories fetch failed`, {
        request_id: requestId,
        error_message: String(memoriesResponse.reason),
      });
    }

    // Parse todos
    let todos: Todo[] = [];
    if (todosResponse.status === 'fulfilled') {
      const data = todosResponse.value;
      const raw = Array.isArray(data) ? data : (data.todos || []);
      todos = raw as Todo[];
      structuredLog.debug(`${toolName}: loaded ${todos.length} todos`, { request_id: requestId });
    } else {
      structuredLog.warn(`${toolName}: todos fetch failed`, {
        request_id: requestId,
        error_message: String(todosResponse.reason),
      });
    }

    // Compose the brief
    const brief = assembleBrief(memories, todos, args.project_name);

    structuredLog.info(`${toolName}: complete`, {
      request_id: requestId,
      brief_length: brief.length,
      memory_count: memories.length,
      todo_count: todos.length,
    });

    return {
      content: [{
        type: 'text',
        text: brief,
      }],
    };
  } catch (error) {
    structuredLog.error(`${toolName}: failed`, {
      request_id: requestId,
      error_message: safeErrorMessage(error),
    });
    return {
      content: [{
        type: 'text',
        text: `❌ Error generating handoff brief: ${safeErrorMessage(error)}`,
      }],
    };
  }
}
