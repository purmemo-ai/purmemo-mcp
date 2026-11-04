// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * One input check for every tool call (2026-11-03).
 *
 * Why: tool arguments used to go straight from the client to the handlers. A name that was
 * slightly off (memory_id for memoryId, content for conversationContent) was silently read
 * as missing, and the user saw a misleading error ('Invalid memory ID: "undefined"',
 * '0 characters'). Models guess snake_case from the rest of the API, so this happened in
 * real sessions. The hosted connector also forwards some tools' arguments to the backend
 * untouched, so a per-handler fix could never cover it.
 *
 * What it does, using each tool's own published inputSchema:
 *   1. Known older spellings are mapped to the published name (ALIASES — the one list).
 *   2. A missing required input fails with a plain message, naming a near-miss the caller
 *      did send ("you sent memory_id — did you mean memoryId?"), so the model fixes its
 *      next call instead of giving up.
 *   3. Other unknown inputs are only logged, never rejected: rejecting them could break
 *      clients that work today. The log shows what to tighten later.
 * Both entry points call it: the local stdio server (server.ts) and the hosted one
 * (remote/start.ts).
 */

/** Published name → older or guessed spellings that mean the same thing. */
export const ALIASES: Record<string, string[]> = {
  memoryId: ['memory_id', 'memoryID', 'id'],
  conversationContent: ['content', 'conversation_content'],
  conversationId: ['conversation_id', 'conversationID'],
  memory_id: ['memoryId', 'memoryID'],
};

/** Inputs any tool may receive without being declared (added by wrappers, not by the tool). */
const ALWAYS_ALLOWED = new Set(['account']);

const squash = (k: string) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Levenshtein distance, small strings only. */
function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function nearMiss(wanted: string, sent: string[]): string | null {
  const w = squash(wanted);
  let best: string | null = null, bestD = 99;
  for (const s of sent) {
    const q = squash(s);
    const dd = q === w ? 0 : (q.includes(w) || w.includes(q)) && q.length >= 2 ? 1 : distance(q, w);
    if (dd < bestD) { best = s; bestD = dd; }
  }
  return bestD <= 2 ? best : null;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export interface CheckResult {
  args: Record<string, unknown>;
  /** Present when the call must not run: a ready-to-return MCP tool result. */
  error?: { content: { type: 'text'; text: string }[]; isError: true };
  /** Inputs the tool doesn't declare (logged by the caller). */
  unknown: string[];
  /** Older spellings that were mapped, as "from→to". */
  mapped: string[];
}

/**
 * Check one call against its tool's published schema. Tools without a schema (or unknown
 * tool names) pass through untouched — the dispatcher decides what to do with those.
 */
export function checkToolInput(toolName: string, rawArgs: unknown, tools: any[]): CheckResult {
  const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...(rawArgs as object) } : {};
  const def = tools.find((t) => t?.name === toolName);
  const props: Record<string, any> = def?.inputSchema?.properties;
  if (!props) return { args, unknown: [], mapped: [] };

  const declared = new Set(Object.keys(props));
  const mapped: string[] = [];

  // 1. Older spellings → published name, only for names this tool declares and the caller left empty.
  for (const name of declared) {
    if (!isEmpty(args[name])) continue;
    for (const alt of ALIASES[name] || []) {
      if (declared.has(alt) || isEmpty(args[alt])) continue;
      args[name] = args[alt];
      delete args[alt];
      mapped.push(`${alt}→${name}`);
      break;
    }
  }

  const unknown = Object.keys(args).filter((k) => !declared.has(k) && !ALWAYS_ALLOWED.has(k));

  // 2. Missing required inputs → one plain message, with near-misses named.
  const required: string[] = Array.isArray(def.inputSchema.required) ? def.inputSchema.required : [];
  const missing = required.filter((r) => isEmpty(args[r]));
  if (missing.length) {
    const lines = missing.map((r) => {
      const guess = nearMiss(r, unknown);
      return guess ? `• ${r} is missing — you sent "${guess}"; did you mean "${r}"?` : `• ${r} is missing (${props[r]?.type || 'value'}).`;
    });
    return {
      args, unknown, mapped,
      error: {
        content: [{ type: 'text', text: `❌ ${toolName} needs:\n${lines.join('\n')}\n\nAccepted inputs: ${[...declared].join(', ')}.` }],
        isError: true,
      },
    };
  }

  return { args, unknown, mapped };
}
