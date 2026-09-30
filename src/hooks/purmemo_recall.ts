#!/usr/bin/env node
/**
 * Purmemo Claude Code — Session Recall + Handoff Brief
 *
 * Fires on SessionStart. Fetches the 5 most recently user-touched memories
 * and active todos, then composes a handoff brief using 5-layer compaction:
 *   Layer 1: Intent (what user was doing — never cut)
 *   Layer 2: Decisions & completions
 *   Layer 3: Open loops (blockers, todos)
 *   Layer 4: Context (tech stack, projects)
 *   Layer 5: Content excerpts (trimmed to budget)
 *
 * Sorts by user_updated_at (not updated_at, which gets bumped by Gemini).
 * Skips on compact/clear. Posts a session context heartbeat.
 * Never blocks session start on any error.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  dbg, errLog, readState, writeState, pruneState, loadApiKey,
  apiGet, apiPost, readHookInput,
  checkForUpdate, autoUpdateHooks, HOOKS_VERSION,
  getAccountSnapshot, type AccountSnapshot, type UsageBucket,
  detectPlatform, initPlatformPaths, platformEvent,
} from './purmemo_lib.js';

const TAG = 'recall';
const MAX_MEMORIES = 5;
const MAX_PREVIEW = 300;
const MAX_TODOS = 8;

// OBSERVATIONS vs RECORDS (2026-09-30). Screenshots, image captures and voice
// notes are things a person or an assistant *observed*; they are searchable but
// they must not take the front-door slots from the documents a session works
// from. Found the hard way: an assistant's pop-up watcher saved a screenshot
// memory every 30 minutes for four days and the brief showed five screenshots
// while the week's real work sat in living documents nothing read.
const OBSERVATION_SOURCE_TYPES = /screenshot|image_capture|image_picker|voice_share|voice_note|cosmo_chat_screenshot/i;
const isObservation = (m: Record<string, unknown>) =>
  OBSERVATION_SOURCE_TYPES.test(String(m.source_type || '')) || /^Cosmo screenshot /.test(String(m.title || ''));

// PINNED DOCUMENTS: living documents read BY ID at every session start, before
// anything "recent". A project pins them in <cwd>/.purmemo/pinned.json and a
// person pins their own in ~/.purmemo/pinned.json — either shape:
//   ["purmemo-next-roadmap", ...]  or  [{"conversationId": "...", "label": "roadmap"}, ...]
// Each entry is fetched by conversation_id (the living-document identity), and
// the brief says how fresh it is and where its last update came from, so a
// session can tell a current record from a stale one instead of guessing.
const MAX_PINNED = 6;
const PINNED_STALE_DAYS = 7;
type Pinned = { conversationId: string; label?: string };
function readPinned(cwd: string | undefined): Pinned[] {
  const files = [
    cwd ? path.join(cwd, '.purmemo', 'pinned.json') : null,
    path.join(os.homedir(), '.purmemo', 'pinned.json'),
  ].filter(Boolean) as string[];
  const out: Pinned[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw?.pinned || []);
      for (const item of list) {
        const p: Pinned = typeof item === 'string' ? { conversationId: item } : { conversationId: String(item?.conversationId || item?.conversation_id || ''), label: item?.label };
        if (p.conversationId && !seen.has(p.conversationId)) { seen.add(p.conversationId); out.push(p); }
      }
    } catch (e) {
      dbg(TAG, `pinned file unreadable ${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out.slice(0, MAX_PINNED);
}

/** One line per pinned document: title, age, and where the last update came from. */
function describePinned(p: Pinned, m: Record<string, unknown> | null): { line: string; stale: boolean } {
  const label = p.label ? `${p.label}: ` : '';
  if (!m) return { line: `• ${label}${p.conversationId} — NOT FOUND (id typo, or it lives in another account)`, stale: true };
  // Freshness = when the CONTENT last changed. content_updated_at moves only on
  // content/title edits (server trigger); user_updated_at was not bumped by
  // living-document appends until purmemo-api 2026-09-30 (a ledger appended
  // daily read "73d ago"); updated_at moves on extraction. Prefer in that order.
  const ts = (m.content_updated_at as string) || (m.user_updated_at as string) || (m.updated_at as string) || (m.created_at as string);
  const ageDays = ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : Infinity;
  const stale = ageDays > PINNED_STALE_DAYS;
  const when = ts ? relativeTime(new Date(ts)) : 'unknown age';
  const via = m.platform ? ` via ${m.platform}` : '';
  const size = typeof m.content === 'string' ? ` · ${Math.round((m.content as string).length / 1000)}K chars` : '';
  return { line: `• ${label}${(m.title as string) || p.conversationId} — updated ${when}${via}${size}${stale ? ' — STALE (>7d): confirm against the transcript before trusting' : ''}`, stale };
}

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Header renderer ─────────────────────────────────────────────────────────
// Two-line header above the recall list, modeled on Claude Code's banner.
//
//   pūrmemo v15.7.8 · chris@purmemo.ai · Pro · 3,205 memories
//   This cycle: 14 recalls · 0 workflows · 287 captures (resets May 31)
//
// Free users with no quota hits show usage with /limits:
//   This cycle: 8/50 recalls · 0/5 workflows · 287 captures (resets May 31)
//
// Free users at-or-over a cap get an upsell line instead of usage:
//   ⚡ Recalls 50/50 — upgrade for unlimited: app.purmemo.ai/dashboard?modal=plans

const UPGRADE_URL = 'https://app.purmemo.ai/dashboard?modal=plans';

function tierDisplayName(tier: string): string {
  if (tier === 'pro') return 'Pro';
  if (tier === 'teams') return 'Teams';
  return 'Free';
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCycleEnd(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return ` (resets ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
  } catch { return ''; }
}

// Pick the first capacity that's at-or-over its limit, in priority order.
// Pro/Teams have unlimited everything, so this is only meaningful for Free.
function firstHitCap(snap: AccountSnapshot): { name: string; bucket: UsageBucket } | null {
  const checks: Array<[string, UsageBucket]> = [
    ['Recalls', snap.recalls],
    ['Workflows', snap.workflows],
    ['Captures', snap.captures],
  ];
  for (const [name, b] of checks) {
    if (!b.unlimited && b.limit > 0 && b.count >= b.limit) {
      return { name, bucket: b };
    }
  }
  return null;
}

function renderUsageLine(snap: AccountSnapshot): string {
  // Each counter renders as "X/L name" if limited, or "X name" if unlimited.
  // Captures stay visible even on Pro because they're a usage flex — the
  // user wants to see "287 captures this cycle" grow over time.
  const part = (label: string, b: UsageBucket): string => {
    return b.unlimited ? `${formatCount(b.count)} ${label}` : `${formatCount(b.count)}/${formatCount(b.limit)} ${label}`;
  };
  const segments = [
    part('recalls', snap.recalls),
    part('workflows', snap.workflows),
    part('captures', snap.captures),
  ];
  return `This cycle: ${segments.join(' · ')}${formatCycleEnd(snap.cycle_end)}`;
}

export function renderSessionHeader(snap: AccountSnapshot): string {
  const tier = tierDisplayName(snap.tier);
  const email = snap.email ?? 'unknown';
  const totalMem = formatCount(snap.total_memories);

  // "✨ updated" badge on the first session after an upgrade. Compare the
  // currently-running HOOKS_VERSION against the version we showed the user
  // last time, stored in state. If they differ, this is the first session
  // on a new version → show the badge and persist the new version so the
  // next session drops it. Skips dev/unstamped builds and skips fresh
  // installs (no last_seen_version yet — those are first-runs, not updates).
  let updatedBadge = '';
  if (!HOOKS_VERSION.startsWith('__')) {
    try {
      const state = readState();
      const lastSeen = state['last_seen_version'] as string | undefined;
      if (lastSeen && lastSeen !== HOOKS_VERSION) {
        updatedBadge = ' ✨ updated';
      }
      if (lastSeen !== HOOKS_VERSION) {
        state['last_seen_version'] = HOOKS_VERSION;
        writeState(state);
      }
    } catch { /* non-fatal — header just omits the badge */ }
  }

  const line1 = `pūrmemo v${HOOKS_VERSION}${updatedBadge} · ${email} · ${tier} · ${totalMem} memories`;

  // Free user with a hit cap → upsell line replaces usage.
  if (snap.tier === 'free') {
    const hit = firstHitCap(snap);
    if (hit) {
      const line2 = `⚡ ${hit.name} ${formatCount(hit.bucket.count)}/${formatCount(hit.bucket.limit)} — upgrade for unlimited: ${UPGRADE_URL}`;
      return `${line1}\n${line2}`;
    }
  }

  return `${line1}\n${renderUsageLine(snap)}`;
}

// ── Handoff Brief Composer ──────────────────────────────────────────────────
// Compaction hierarchy: Intent → Decisions → Open Loops → Context → Content

function composeHandoffBrief(
  memories: Array<Record<string, unknown>>,
  todos: Array<Record<string, unknown>>,
  projectName: string,
): string {
  if (!memories.length) return '';

  const lines: string[] = [`[Purmemo — handoff brief for "${projectName}"]`];

  // Layer 1: Intent — what user was trying to accomplish
  const primary = memories[0];
  if (primary.primary_intent) lines.push(`Goal: ${primary.primary_intent}`);
  if (primary.summary) lines.push(`Last session: ${primary.summary}`);
  if (primary.key_result) lines.push(`Key result: ${primary.key_result}`);
  if (primary.next_phase_hint && primary.next_phase_hint !== 'other') {
    lines.push(`Next phase: ${primary.next_phase_hint}`);
  }

  // Prior session summaries (dedup by project)
  const seenProjects = new Set<string>();
  if (primary.project_name) seenProjects.add(primary.project_name as string);
  for (let i = 1; i < memories.length; i++) {
    const m = memories[i];
    if (!m.summary) continue;
    const proj = (m.project_name as string) || '';
    if (proj && seenProjects.has(proj)) continue;
    if (proj) seenProjects.add(proj);
    lines.push(`Prior: ${m.summary}`);
  }

  // Layer 2: Decisions & completions (prefer V2.1 decisions[] over work_items)
  const decisions: string[] = [];
  const completions: string[] = [];
  for (const m of memories) {
    const decisionsList = (m.decisions as Array<Record<string, unknown>>) || [];
    if (decisionsList.length > 0) {
      for (const d of decisionsList) {
        if (decisions.length < 4) {
          const rationale = d.rationale ? ` — ${d.rationale}` : '';
          decisions.push(`  - ${d.text}${rationale}`);
        }
      }
    } else {
      const workItems = (m.work_items as Array<Record<string, unknown>>) || [];
      for (const item of workItems) {
        if (item.type === 'decision' && decisions.length < 4) {
          decisions.push(`  - ${item.text}`);
        }
      }
    }
    const comps = (m.completions as Array<Record<string, unknown>>) || [];
    for (const c of comps) {
      if (completions.length < 3) completions.push(`  - ${c.text}`);
    }
  }
  if (decisions.length) lines.push(`Decisions:\n${decisions.join('\n')}`);
  if (completions.length) lines.push(`Completed:\n${completions.join('\n')}`);

  // Layer 3: Open loops — blockers, open items, todos
  const blockers: string[] = [];
  const openItems: string[] = [];
  for (const m of memories) {
    const bList = (m.blockers as Array<Record<string, unknown>>) || [];
    for (const b of bList) {
      if (blockers.length < 4) blockers.push(`  - ${b.text}`);
    }
    const wList = (m.work_items as Array<Record<string, unknown>>) || [];
    for (const item of wList) {
      if (item.type !== 'decision' && item.status !== 'done' && openItems.length < 4) {
        openItems.push(`  - ${item.text}`);
      }
    }
  }
  const activeTodos: string[] = [];
  for (const t of todos) {
    if (t.status !== 'done' && activeTodos.length < 4) {
      const prio = t.priority ? ` [${t.priority}]` : '';
      activeTodos.push(`  - ${t.text}${prio}`);
    }
  }
  if (blockers.length) lines.push(`Blockers:\n${blockers.join('\n')}`);
  if (openItems.length) lines.push(`Open items:\n${openItems.join('\n')}`);
  if (activeTodos.length) lines.push(`Active todos:\n${activeTodos.join('\n')}`);

  // Layer 4: Context — technologies, projects
  const techs = new Set<string>();
  for (const m of memories) {
    const tList = (m.technologies as string[]) || [];
    for (const t of tList) techs.add(t);
  }
  if (techs.size > 0) lines.push(`Stack: ${Array.from(techs).slice(0, 8).join(', ')}`);

  lines.push('');
  lines.push(`${memories.length} recent memories loaded. Type a number to load fully.`);

  return lines.join('\n');
}

async function main(): Promise<void> {
  let hookData;
  try { hookData = await readHookInput(); } catch { return; }
  if (!hookData) return;

  const platform = detectPlatform(hookData);
  initPlatformPaths(platform);

  const { session_id, cwd, source } = hookData;
  dbg(TAG, `fired — platform=${platform} source=${source} session=${session_id} cwd=${cwd}`);

  // compact: the conversation is still here, only summarized — nothing to re-hydrate.
  // clear: the context is gone but the session (and a phone attached to it) stays —
  // this is exactly when the brief must run again (2026-09-30: `/clear` is how a
  // long-lived remote-controlled session starts its next task without losing the phone).
  if (source === 'compact') {
    dbg(TAG, `skip — source=${source}`);
    return;
  }

  const apiKey = loadApiKey();
  if (!apiKey) { errLog(TAG, 'no API key — set PURMEMO_API_KEY or run purmemo setup'); return; }

  const projectName = path.basename(cwd || process.cwd());

  // Post session context (fire-and-forget)
  const platformName = platform === 'gemini' ? 'gemini' : platform === 'codex' ? 'codex' : 'claude-code';
  apiPost(apiKey, '/api/v1/identity/session', {
    project: projectName, platform: platformName, auto: true,
  }, 5000).then(r => dbg(TAG, `session POST → ${r ? 'ok' : 'error'}`));

  // Fetch recent memories + active todos + account snapshot in parallel.
  // The account snapshot (tier + usage counters) is fetched live every
  // session — caching would lie to users about quota state and capture
  // counts. Parallel with memory fetch means ~0ms added wall-clock cost.
  const params = new URLSearchParams({
    limit: String(MAX_MEMORIES * 3), // headroom: one-shot captures are filtered out below
    sort: 'user_updated_at',
    order: 'desc',
  });
  const [memResult, todosResult, account] = await Promise.all([
    apiGet(apiKey, `/api/v1/memories/?${params}`),
    apiGet(apiKey, `/api/v1/todos?limit=${MAX_TODOS}`).catch(() => null),
    getAccountSnapshot(apiKey),
  ]);
  const fetchedMemories = (memResult as { memories?: Array<Record<string, unknown>> })?.memories || [];
  // Observations never take a front-door slot (see OBSERVATION_SOURCE_TYPES).
  const observationCount = fetchedMemories.filter(isObservation).length;
  const allMemories = fetchedMemories.filter(m => !isObservation(m));

  // Pinned documents, by id, in parallel — the front door reads the record a
  // session works from, not whatever was touched last.
  const pinned = readPinned(cwd);
  const pinnedRows = await Promise.all(pinned.map(async (p) => {
    try {
      const q = new URLSearchParams({ conversation_id: p.conversationId, limit: '1' });
      const r = await apiGet(apiKey, `/api/v1/memories/?${q}`) as { memories?: Array<Record<string, unknown>> };
      return describePinned(p, r?.memories?.[0] ?? null);
    } catch (e) {
      dbg(TAG, `pinned fetch failed ${p.conversationId}: ${e instanceof Error ? e.message : e}`);
      return describePinned(p, null);
    }
  }));
  const pinnedBlock: string[] = [];
  if (pinnedRows.length) {
    const staleCount = pinnedRows.filter(r => r.stale).length;
    pinnedBlock.push(`[Pinned documents — read these first; they are the record this work runs from]`);
    for (const r of pinnedRows) pinnedBlock.push(r.line);
    pinnedBlock.push(staleCount
      ? `Trust: ${pinnedRows.length - staleCount}/${pinnedRows.length} current, ${staleCount} stale — where a pinned document is stale, the transcript wins; say so rather than guess.`
      : `Trust: all ${pinnedRows.length} pinned documents updated within ${PINNED_STALE_DAYS} days.`);
    if (observationCount) pinnedBlock.push(`(${observationCount} observation${observationCount === 1 ? '' : 's'} — screenshots/captures — kept out of the recent list; still searchable.)`);
  }
  // The brief's LIST shows the last MAX_MEMORIES saves from ANY source (iOS
  // share, web clipper, phone, CLI) — that is the hook's whole point. Only the
  // "Last session:" slot (memories[0]) must be conversation-derived, so a
  // one-shot capture can't masquerade as the last working session (an iOS-shared
  // AI-news item once claimed the line; the first fix filtered ALL slots and hid
  // one-shot saves entirely — corrected 2026-07-18). Conversation memories carry
  // a conversation_id (or session_id); one-shot captures don't.
  const isConversationMemory = (m: Record<string, unknown>) => Boolean(m.conversation_id || m.session_id);
  let memories = allMemories.slice(0, MAX_MEMORIES);
  const primaryIdx = memories.findIndex(isConversationMemory);
  if (primaryIdx > 0) {
    memories.unshift(memories.splice(primaryIdx, 1)[0]);
  } else if (primaryIdx === -1) {
    // No conversation memory in the top window — pull the newest one from the
    // 3× headroom fetch so "Last session:" still names a real session, then
    // keep the rest of the list as the true latest saves.
    const conv = allMemories.find(isConversationMemory);
    if (conv) memories = [conv, ...memories].slice(0, MAX_MEMORIES);
  }
  const todos = (Array.isArray(todosResult) ? todosResult : (todosResult as { todos?: Array<Record<string, unknown>> })?.todos) || [];
  dbg(TAG, `recalled ${memories.length} memories, ${todos.length} todos, account=${account?.tier ?? 'unknown'}`);

  if (!memories.length && !pinnedBlock.length) { dbg(TAG, 'no memories found'); return; }

  // Compose handoff brief from V2 intelligence data
  const handoffBrief = composeHandoffBrief(memories, todos, projectName);

  // Pinned documents first (the record), then the brief, then the recent list.
  const contextLines = pinnedBlock.length ? [...pinnedBlock, '', handoffBrief] : [handoffBrief];
  contextLines.push('');
  memories.forEach((mem, i) => {
    const title = (mem.title as string) || 'Untitled';
    const ts = (mem.updated_at as string) || (mem.created_at as string);
    const when = ts ? relativeTime(new Date(ts)) : '';
    contextLines.push(`${i + 1}. ${title}${when ? ` (${when})` : ''}`);
  });

  // Store recall data for first_message hook
  let state = pruneState(readState());
  state[`session_recall_${session_id}`] = {
    project: projectName,
    titles: memories.map(m => (m.title as string) || 'Untitled'),
    ids: memories.map(m => m.id as string),
  };
  writeState(state);

  // Check for hook updates (non-blocking, cached for 24h)
  const latestVersion = await checkForUpdate();
  let updateNotice = '';
  if (latestVersion) {
    // Try auto-update in background (at most once per 6h)
    const triggered = await autoUpdateHooks();
    updateNotice = triggered
      ? `\npurmemo updating ${HOOKS_VERSION} → ${latestVersion}… (will apply next session)\n`
      : `\npurmemo ${HOOKS_VERSION} → ${latestVersion} available. Run: npx purmemo-mcp@latest --update\n`;
  }

  // Render the header (tier + usage). Falls back to no header if the account
  // snapshot couldn't load — never block session start on a stale telemetry
  // call. Keeps the existing memory list rendering exactly as-is.
  const header = account ? renderSessionHeader(account) : '';
  const headerBlock = header ? `${header}\n\n` : '';

  // Numbered list visible to user, full context silent to Claude
  const recentList = memories
    .map((m, i) => `${i + 1}. ${(m.title as string) || 'Untitled'}`)
    .join('\n');
  // The person sees the pinned documents and their freshness too — that line is
  // the signal that a fresh session can be trusted, or that the transcript wins.
  const banner = pinnedBlock.length ? `${pinnedBlock.join('\n')}\n\nRecent:\n${recentList}` : recentList;

  // Platform-aware output. Claude Code treats `additionalContext` as silent
  // (model-only) and `systemMessage` as user-visible — so we send the rich
  // handoff brief silently and the numbered list visibly.
  //
  // Gemini CLI renders `systemMessage` TWICE for a single SessionStart hook
  // result (verified in their source — packages/cli/src/ui/AppContainer.tsx
  // adds an unlabeled INFO item directly after fireSessionStartEvent, AND
  // its HookSystemMessage subscriber adds a SECOND INFO item with the script
  // path as `source` — the "[node /Users/.../purmemo_recall.js]" label).
  // Both renders check only `result.systemMessage`; neither honors
  // `suppressOutput`, so we cannot reduce to one block from our side.
  // Tracked upstream — for now we omit `additionalContext` on Gemini to at
  // least avoid making the duplicate worse, and accept the cosmetic issue.
  const visibleMessage = `${updateNotice}${headerBlock}${banner}\n\nType a number to load a memory.`;
  const payload: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: platformEvent('SessionStart', platform) },
    systemMessage: visibleMessage,
  };
  if (platform !== 'gemini') {
    (payload.hookSpecificOutput as Record<string, unknown>).additionalContext = contextLines.join('\n');
  }
  process.stdout.write(JSON.stringify(payload));
}

await main().catch((e: Error) => { process.stderr.write(`[purmemo:recall] fatal: ${e.message}\n`); });
