// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * Which tools the server lists (2026-10-18; per account since 2026-11-09).
 *
 * A crowded tool list makes assistants choose worse, so everyone sees a small
 * core. Two more kinds of tool exist:
 *
 * GATED tools belong to a feature of the caller's ACCOUNT (plan + invite
 * grants, decided by purmemo-next and cached in lib/features.ts). A gated tool
 * is listed only when the account holds its feature AND the tool's switch is
 * not off. A switch is a kill-switch for the whole process: off (or unset)
 * hides the tool for everyone; on never grants anything.
 *   what_changed          feature 'notebook'         (no switch)
 *   search_past_sessions  feature 'sessions_search'  switch PURMEMO_SESSIONS_BETA=1
 * Features unknown (the lookup failed or has not answered) = gated tools stay
 * hidden; the core never depends on the lookup.
 *
 * PAUSED tools are not deleted: handlers stay, and operator flags bring groups
 * back for the whole process (unset on the hosted connector):
 *   PURMEMO_ADMIN=1          → adds the three admin tools (live checks the key)
 *   PURMEMO_LEGACY_TOOLS=1   → adds every paused tool
 * A paused tool called while hidden answers with what to use instead.
 */

export const CORE_TOOLS = ['save_conversation', 'recall_memories', 'get_memory_details', 'get_user_context'];
export const GATED_TOOLS: Record<string, { feature: string; switchOn: (env: NodeJS.ProcessEnv) => boolean }> = {
  what_changed: { feature: 'notebook', switchOn: () => true },
  search_past_sessions: { feature: 'sessions_search', switchOn: (env) => env.PURMEMO_SESSIONS_BETA === '1' },
};
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

/** Could this process list the tool for SOME account? (core; gated with its switch on; admin/paused with their flag) */
export function isToolListable(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const f = toolFlags(env);
  if (CORE_TOOLS.includes(name)) return true;
  if (GATED_TOOLS[name]) return GATED_TOOLS[name].switchOn(env);
  if (ADMIN_TOOLS.includes(name)) return f.admin;
  if (LEGACY_TOOLS.includes(name)) return f.legacy;
  return false;
}

/** Is the tool listed for an account holding `features`? features null/undefined = unknown = gated tools hidden. */
export function isToolVisible(name: string, env: NodeJS.ProcessEnv = process.env, features: string[] | null = null): boolean {
  if (!isToolListable(name, env)) return false;
  const gate = GATED_TOOLS[name];
  return gate ? Boolean(features && features.includes(gate.feature)) : true;
}

/** Everything this process could list for some account (the superset tools/list is cut from, per caller). */
export function listableTools(allTools: any[], env: NodeJS.ProcessEnv = process.env): any[] {
  return allTools.filter((t) => isToolListable(t.name, env));
}

/** The tools/list payload for an account holding `features`. With session search listed, recall_memories points to it. */
export function visibleTools(allTools: any[], env: NodeJS.ProcessEnv = process.env, features: string[] | null = null): any[] {
  const shown = allTools.filter((t) => isToolVisible(t.name, env, features));
  const sessions = shown.some((t) => t.name === 'search_past_sessions');
  return shown.map((t) => (sessions && t.name === 'recall_memories'
    ? { ...t, description: `${t.description}\n\n${RECALL_SESSIONS_HINT}` }
    : t));
}

/**
 * A gated tool called by an account that may not use it: the tool result to return, or null to run it.
 * features: the account's features, or null when they could not be confirmed (fail closed, said plainly).
 */
export function gatedToolResult(name: string, env: NodeJS.ProcessEnv = process.env, features: string[] | null = null) {
  const gate = GATED_TOOLS[name];
  if (!gate) return null;
  let text: string | null = null;
  if (!gate.switchOn(env)) text = `${name} is not available here.`;
  else if (!features) text = `Could not confirm what your plan includes just now, so ${name} was not run. Try again in a minute. The rest of purmemo is unaffected.`;
  else if (!features.includes(gate.feature)) text = `${name} is not part of your plan.`;
  return text ? { content: [{ type: 'text', text }], isError: true } : null;
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
