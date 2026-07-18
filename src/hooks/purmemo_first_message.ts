#!/usr/bin/env node
/**
 * Purmemo First-Message — Number Quick-Load
 *
 * Fires on UserPromptSubmit. On the first user message of a session,
 * checks if the user typed a number (1-5) to load a recalled memory fully.
 * Only fires once per session. Silent on all errors.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  dbg, errLog, readState, writeState, loadApiKey,
  apiGet, readHookInput,
  detectPlatform, initPlatformPaths, platformEvent,
} from './purmemo_lib.js';

const TAG = 'first_msg';

function countUserMessages(transcriptPath: string): number {
  try {
    const expanded = transcriptPath.replace(/^~/, os.homedir());
    if (!fs.existsSync(expanded)) return 0;
    const raw = fs.readFileSync(expanded, 'utf8').trim();
    if (!raw) return 0;

    // Gemini JSON format: { messages: [{ type: "user" | "gemini" }] }
    // Claude JSONL lines ALSO start with '{', so a whole-file JSON.parse
    // throws on line 2 — that must fall through to the per-line JSONL
    // parser below, not return 0 (the old sniffing bug counted every
    // Claude transcript as having zero user messages).
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const data = JSON.parse(raw);
        const msgs = data.messages || data.turns || [];
        if (Array.isArray(msgs) && msgs.length) {
          return msgs.filter((m: Record<string, unknown>) =>
            m.type === 'user' || m.role === 'user' || m.role === 'human'
          ).length;
        }
      } catch { /* not a single-doc transcript — fall through to JSONL */ }
    }

    // Claude JSONL format — count only real user prompts, not tool_result
    // turns (those also arrive as type "user" with array content).
    let count = 0;
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;
        const content = entry.message?.content;
        if (typeof content === 'string') { count++; continue; }
        if (Array.isArray(content) && content.some((b: Record<string, unknown>) => b?.type === 'text')) count++;
      } catch {}
    }
    return count;
  } catch { return 0; }
}

async function main(): Promise<void> {
  let hookData;
  try { hookData = await readHookInput(); } catch { return; }
  if (!hookData) return;

  const platform = detectPlatform(hookData);
  initPlatformPaths(platform);

  const { session_id, transcript_path } = hookData;
  if (!session_id || !transcript_path) return;

  const state = readState();
  const bannerKey = `banner_shown_${session_id}`;
  if (state[bannerKey]) return;

  const userMsgCount = countUserMessages(transcript_path);
  if (userMsgCount > 1) {
    state[bannerKey] = true;
    writeState(state);
    return;
  }

  // First message — check for recalled memories from session start
  const recalled = state[`session_recall_${session_id}`] as {
    titles?: string[];
    ids?: string[];
    project?: string;
  } | undefined;
  state[bannerKey] = true;
  writeState(state);

  if (!recalled?.titles?.length) {
    dbg(TAG, `no recall data for session ${session_id}`);
    return;
  }

  // Check if user typed a number (1-5) to load a memory
  const prompt = (hookData.prompt || '').trim();
  const numMatch = prompt.match(/^([1-5])$/);

  if (numMatch && recalled.ids) {
    const idx = parseInt(numMatch[1], 10) - 1;
    const memId = recalled.ids[idx];
    const memTitle = recalled.titles[idx] || `Memory ${numMatch[1]}`;

    if (memId) {
      dbg(TAG, `loading #${numMatch[1]} — ${memId} (${memTitle})`);
      const apiKey = loadApiKey();
      if (apiKey) {
        const mem = await apiGet(apiKey, `/api/v1/memories/${memId}`) as { content?: string } | null;
        if (mem?.content) {
          const content = mem.content
            .replace(/=== CONVERSATION START ===|=== .* ===/g, '')
            .trim();
          dbg(TAG, `loaded "${memTitle}" — ${content.length} chars`);
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: platformEvent('UserPromptSubmit', platform),
              additionalContext: `[Purmemo — full memory loaded: "${memTitle}"]\n\n${content}`,
            },
          }));
          return;
        }
      }
      errLog(TAG, `failed to load memory ${memId}`);
    }
  }

  dbg(TAG, `first message — no number shortcut, session ${session_id}`);
}

await main().catch((e: Error) => { process.stderr.write(`[purmemo:first_msg] fatal: ${e.message}\n`); });
