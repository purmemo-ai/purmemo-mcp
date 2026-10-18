// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * Which tools the server lists (2026-10-18).
 *
 * A crowded tool list makes assistants choose worse, so everyone sees a small
 * core by default. The rest is paused, not deleted: handlers stay, and env
 * flags bring groups back.
 *   PURMEMO_SESSIONS_BETA=1  → adds search_past_sessions
 *   PURMEMO_ADMIN=1          → adds the three admin tools
 *   PURMEMO_LEGACY_TOOLS=1   → adds every paused tool
 * A paused tool called while hidden answers with what to use instead.
 */

export const CORE_TOOLS = ['save_conversation', 'recall_memories', 'get_memory_details', 'what_changed', 'get_user_context'];
export const BETA_TOOLS = ['search_past_sessions'];
export const ADMIN_TOOLS = ['get_acknowledged_errors', 'save_investigation_result', 'get_investigations'];
export const LEGACY_TOOLS = [
  'save_artifact', 'commit',
  'snapshot', 'snapshot_sources', 'save_snapshot', 'get_snapshot', 'accept_snapshot',
  'list_clusters', 'discover_related_conversations',
  'run_workflow', 'list_workflows',
  'share_memory', 'recall_public', 'get_public_memory', 'report_memory',
  'generate_handoff_brief', 'save_test_result', 'get_test_results', 'get_artifacts',
  'get_next_task', 'complete_task'
];

export const RECALL_SESSIONS_HINT = 'For what was actually said or decided in a past session (the raw transcript), use search_past_sessions.';

export function toolFlags(env: NodeJS.ProcessEnv = process.env) {
  return {
    beta: env.PURMEMO_SESSIONS_BETA === '1',
    admin: env.PURMEMO_ADMIN === '1',
    legacy: env.PURMEMO_LEGACY_TOOLS === '1'
  };
}

export function isToolVisible(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const f = toolFlags(env);
  if (CORE_TOOLS.includes(name)) return true;
  if (BETA_TOOLS.includes(name)) return f.beta;
  if (ADMIN_TOOLS.includes(name)) return f.admin;
  if (LEGACY_TOOLS.includes(name)) return f.legacy;
  return false;
}

/** The tools/list payload for this env. With the sessions beta on, recall_memories points to search_past_sessions. */
export function visibleTools(allTools: any[], env: NodeJS.ProcessEnv = process.env): any[] {
  const f = toolFlags(env);
  return allTools
    .filter((t) => isToolVisible(t.name, env))
    .map((t) => (f.beta && t.name === 'recall_memories'
      ? { ...t, description: `${t.description}\n\n${RECALL_SESSIONS_HINT}` }
      : t));
}

const REDIRECTS = {
  save_artifact: 'Use save_conversation instead.',
  commit: 'Use save_conversation instead.',
  discover_related_conversations: 'Use recall_memories instead.',
  list_clusters: 'Use recall_memories instead.',
  snapshot: 'Use recall_memories instead (it returns summary pages).',
  snapshot_sources: 'Use recall_memories instead (it returns summary pages).',
  save_snapshot: 'Use recall_memories instead (it returns summary pages).',
  get_snapshot: 'Use recall_memories instead (it returns summary pages).',
  accept_snapshot: 'Use recall_memories instead (it returns summary pages).'
};

/** Message for a paused tool called while hidden; null when the call should run. */
export function pausedToolMessage(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!LEGACY_TOOLS.includes(name) || toolFlags(env).legacy) return null;
  const instead = REDIRECTS[name];
  return instead
    ? `⏸️ ${name} is paused. ${instead} (To turn the paused tools back on, set PURMEMO_LEGACY_TOOLS=1.)`
    : `⏸️ ${name} is paused; set PURMEMO_LEGACY_TOOLS=1 to turn it back on.`;
}

/** Message for an admin tool called without admin mode; null when the call should run. */
export function adminToolMessage(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ADMIN_TOOLS.includes(name) || toolFlags(env).admin) return null;
  return '❌ Admin access required. Set PURMEMO_ADMIN=1 and provide a valid admin API key.';
}

/** Tool result to return instead of running a hidden tool, or null to run it. Used by both the stdio and remote dispatch. */
export function hiddenToolResult(name: string, env: NodeJS.ProcessEnv = process.env) {
  const text = pausedToolMessage(name, env) || adminToolMessage(name, env);
  return text ? { content: [{ type: 'text', text }], isError: true } : null;
}
