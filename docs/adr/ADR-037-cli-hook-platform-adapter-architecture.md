# ADR-037: CLI Hook Platform-Adapter Architecture

**Date:** 2026-05-03
**Status:** Proposed
**Deciders:** Chris Oladapo
**Scope:** This ADR addresses the SessionStart recall hook (`purmemo_recall.ts`) only — NOT the broader hook+commands install pipeline (`installHooks`, `installGeminiExtension`, `installCodexHooks`, slash commands, TOML commands, codex skill). Those install paths remain as-is.
**Supersedes:** Implicit "platform if/else" pattern in `src/hooks/purmemo_recall.ts`
**Related:** ADR-017 (MCP distribution parity), ADR-035 (CLI distribution curl installer), v15.1.0 hooks rewrite (commit `1527066`, March 22 — "elegant solution" mandate that consolidated 8 hooks into 4 files with shared `purmemo_lib`), v15.3.0 capture retirement (commit `9291ee5`, "AMP is canonical capture path")

## Context and Problem Statement

`purmemo-mcp` ships a single SessionStart hook to three CLI platforms: Claude Code, Gemini CLI, and Codex CLI. The hook does the same logical work everywhere — fetch memories + todos + account snapshot, compose a handoff brief — but each platform's terminal renderer has incompatible quirks:

| Concern | Claude Code | Gemini CLI | Codex CLI |
|---|---|---|---|
| `additionalContext` rendering | Silent (model-only) | Visible & rendered as banner | Flattened to single line by TUI |
| `systemMessage` rendering | Plain INFO block | Renders **twice** (upstream bug [google-gemini/gemini-cli#26395](https://github.com/google-gemini/gemini-cli/issues/26395)) | Always labeled `warning:` (severity-coloured) |
| Multi-line layout | Preserved | Preserved (in 1 of the 2 renders) | Newlines collapsed |
| Title length tolerance | ~80 char | ~80 char | ~44 char before wrap-ugly |
| Memory count tolerance | 5 fits cleanly | 5 fits cleanly | 3 max before TUI feels noisy |
| Hook fires reliably on | All sources | All sources (with double-render) | Only `codex exec`; interactive TUI is upstream-broken ([openai/codex#17532](https://github.com/openai/codex/issues/17532)) |
| Enable required | None | None | `[features] codex_hooks = true` in `~/.codex/config.toml` |
| Header (tier + usage) | Renders cleanly | Renders cleanly | Fights the `warning:` label — feels broken |

The current implementation handles these via a single `if (platform === 'gemini') / else` branch inside `main()` in `src/hooks/purmemo_recall.ts`. This is already failing:

1. **Hand-edited divergence.** During the 2026-05-03 morning Codex debugging session, a separate compact-mode build was hand-deployed to `~/.codex/hooks/purmemo_recall.js` (262 lines, with `truncateTitle`, no header, `(none)` warning payload). This code exists nowhere in the source repo. A future `purmemo --update` will silently overwrite it and regress Codex.

2. **Cross-platform regressions.** The same morning session shipped a Gemini stderr workaround that touched the unified output path; the manual Claude redeploy copied `dist/hooks/purmemo_lib.js` straight into `~/.claude/hooks/` without running the `__HOOKS_VERSION__` placeholder substitution that `installHooks()` performs at install time (`setup.ts:774-778`). The placeholder lives in `purmemo_lib.ts:49` (`export const HOOKS_VERSION = '__HOOKS_VERSION__'`) and is stamped in three separate places — Claude (`setup.ts:777`), Gemini (`setup.ts:1073`), Codex (`setup.ts:1186`) — each writing to a different deployment path. The morning copy bypassed all three, so Claude's banner rendered `pūrmemo v__HOOKS_VERSION__` for ~1 hour before being patched in-place via `sed`.

3. **No isolation, no testability.** Every platform's behavior runs through the same function. There is no way to unit-test "what does Codex render with these inputs" without a live API key + mock hook input. There is no way to edit Codex compact mode confident that you haven't broken Claude.

4. **Three branches in source vs N in deployed files.** Source has one branch (gemini, currently uncommitted); on disk Codex has its own ad-hoc fork. The architecture has secretly become 2.5 branches across three filesystems.

This pattern won't survive a fourth platform. Cursor, Aider, and any future CLI with hooks would each compound the tangle.

## Decision Drivers

- **One ship, multiple renderers.** Same `dist/hooks/purmemo_recall.js` deploys to every platform. `--update` story stays unchanged. No per-platform npm package.
- **Independent editability.** Editing Codex compact mode must not require reading or risking Claude code.
- **Testability without a network round-trip.** Each renderer should be a pure function `(input) → {stdout, stderr}` so all three can be unit-tested with fixture data.
- **Additive for new platforms.** Adding Cursor support tomorrow should mean writing one new file (~50 lines), not touching any existing platform's code.
- **No new runtime dependencies.** Hook size matters — these scripts run on every session start. The pattern must compile to plain JS with no plugin-loader overhead.
- **Match the working source-of-truth pattern.** Whatever lands must be reproducible from `src/`, not hand-edited at install time.
- **Survives `--update`.** `setup.ts` reconcileInstallation already overwrites the deployed `.js`; the new architecture must mean the overwritten copy contains the right per-platform behavior, not a unified-and-broken one.
- **Preserves existing hook constraints.** The hook uses top-level `await main().catch(...)` (commit `2c52404`, "use top-level await in hooks to prevent premature exit") — the new orchestrator must keep this shape. Error signaling and JSONL parsing semantics from `e5dfe44` must not regress.
- **Architectural continuity, not departure.** This refactor extends two prior "extract concerns from the hook" decisions: `a0e3829` (chunking moved from hooks to API — "single-row living documents") and `9291ee5` (capture retired entirely — "AMP is canonical capture path"). The hook's job has been steadily narrowing toward "render only." Adapters complete that arc.

## Options Considered

### Option 1: Strategy / Adapter pattern — shared orchestrator + per-platform renderers

- **Description:** Refactor `src/hooks/purmemo_recall.ts` into a thin orchestrator that does all platform-agnostic work (fetch, compose handoff brief, prepare visible banner, prepare update notice), then delegates final output to a `PlatformAdapter`. Three adapter modules — `adapters/claude.ts`, `adapters/gemini.ts`, `adapters/codex.ts` — each export one function with the signature `render(input: RenderInput): { stdout: string; stderr?: string }`. An `adapters/index.ts` exposes a registry `{ claude, gemini, codex }`. The orchestrator's last lines become:

  ```ts
  const adapter = adapters[platform];
  const { stdout, stderr } = adapter.render(input);
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(stdout);
  ```

  Each adapter is a dumb formatter — it never fetches, never composes, never decides what data to load. The adapter receives the already-prepared payload (memories, todos, account, handoffBrief, visibleBanner, updateNotice, eventName) and decides only **what stream**, **what JSON shape**, and **how compact**.

- **Pros:**
  - Direct match for the actual problem shape: shared *work*, divergent *rendering*.
  - Adapter is ~30-60 lines per platform — the natural editing unit.
  - Trivially unit-testable: pass fixture `RenderInput`, assert `stdout`/`stderr`. No network, no fakes.
  - Adding a platform is one new file plus one entry in the registry — zero risk to existing platforms.
  - Compiles to plain JS, no runtime plugin loader, no dynamic require.
  - The Codex compact branch (currently orphaned in `~/.codex/hooks/`) becomes its rightful home in `adapters/codex.ts` and survives `--update`.
- **Cons:**
  - One-time refactor cost (~1-2 hours). Code is moving, not being created — risk is low but non-zero.
  - Three small files instead of one larger file. For a reader scanning the codebase, slightly more navigation. Mitigated by the single-purpose name.
- **Past experience:** This is the **canonical** "shared core, swappable renderer" shape. ESLint formatters use this exact pattern: a single linter core produces a `LintResult[]`, then one of N formatter functions (`stylish`, `compact`, `json`, `junit`, custom) renders it for the target. Closer to home: the v15.1.0 "elegant solution" rewrite (commit `1527066`, March 22) consolidated 8 duplicated hook files into 4 with shared `purmemo_lib` — the same instinct now extended one layer down (1 unified output path → 3 platform-aware adapters). Continuity, not reversal.

### Option 2: Capabilities / feature-flag table on platform

- **Description:** Keep one `main()` function. Define a `PlatformCapabilities` record per platform: `{ supportsAdditionalContext: boolean, supportsMultiline: boolean, maxTitleChars: number, maxPreviewMemories: number, useStderr: boolean, systemMessageLabel: 'plain' | 'warning' }`. The orchestrator branches on individual capabilities at each output decision point.

- **Pros:**
  - No new files. Single function stays single.
  - Capabilities table makes platform differences explicit in one glanceable place.
- **Cons:**
  - **Capabilities and rendering aren't separable.** The Gemini double-render bug isn't a "capability" — it's a rendering quirk that requires a non-obvious workaround (write to stderr, send empty `systemMessage`). The Codex `(none)` payload is the same. Forcing these into capability flags creates flags like `requiresStderrWorkaround: true` and `requiresNonEmptyStringSentinel: true` that mean nothing outside their one usage site.
  - Every new platform-specific quirk grows the capabilities table and adds another `if (caps.foo)` branch in the orchestrator. The function gets longer, not shorter.
  - Still hard to unit-test individual platforms — they share the same function body.
- **Past experience:** This is the pattern that the current code has been drifting toward. We already know it doesn't scale past two platforms.

### Option 3: Per-platform binary (separate `dist/hooks/claude/`, `dist/hooks/gemini/`, `dist/hooks/codex/`)

- **Description:** Three completely independent hook entry points, each compiled from its own TypeScript file. `setup.ts` deploys the appropriate one to each platform's hook directory.

- **Pros:**
  - Maximum isolation — Codex changes literally cannot touch Claude's binary.
  - Each file is self-contained.
- **Cons:**
  - **Triplicates the orchestrator.** Memory-fetch, todo-fetch, brief-composition, version-check, state-write — all duplicated 3×. Bug fixes in shared logic must land in three places.
  - Violates ADR-017 (distribution parity). Three binaries create three update surfaces. Drift becomes near-inevitable.
  - Larger npm bundle, slower install.
  - Composing fix is "edit three files," which is exactly the problem Option 1 solves.
- **Past experience:** None in purmemo; this is the anti-pattern that the early Chrome ext / desktop / web split *would* have created without a shared `lib/`.

### Option 4: Plugin-loader runtime (oclif-style dynamic plugin discovery)

- **Description:** Adopt or borrow oclif's plugin-loading machinery. Each adapter is a dynamically-discoverable npm package (`purmemo-hook-formatter-codex`, etc.). The hook entrypoint resolves and loads them at runtime.

- **Pros:**
  - Allows third parties to ship custom adapters without forking purmemo-mcp.
- **Cons:**
  - **Massively over-engineered for our actual problem.** We have three adapters, all maintained by us, all shipped together. We are not building an extensible third-party ecosystem.
  - Adds runtime cost on every session start (plugin discovery + dynamic require) for zero practical benefit.
  - Adds a publish-coordination story (every adapter needs its own version + release).
- **Past experience:** None. Would be the first time we adopted a runtime plugin loader. Burden of proof is high; nothing in the current product roadmap calls for it.

## Decision

**Adopt Option 1: Strategy / Adapter pattern.**

The hook splits into:

```
src/hooks/
  purmemo_recall.ts          ← orchestrator only. NO platform branches.
  purmemo_lib.ts             ← unchanged
  adapters/
    types.ts                 ← PlatformAdapter interface, RenderInput type
    claude.ts                ← Claude renderer (additionalContext silent + systemMessage visible)
    gemini.ts                ← Gemini renderer (stderr workaround for #26395)
    codex.ts                 ← Codex renderer (compact mode, truncateTitle, "(none)" payload)
    index.ts                 ← export const adapters = { claude, gemini, codex }
```

The `PlatformAdapter` interface:

```ts
export interface RenderInput {
  memories: Memory[];
  todos: Todo[];
  account: AccountSnapshot | null;
  handoffBrief: string;     // pre-composed by orchestrator
  visibleBanner: string;    // pre-composed numbered list
  updateNotice: string;     // pre-composed update string (may be empty)
  eventName: string;        // result of platformEvent('SessionStart', platform)
  sessionId: string;
}

export interface PlatformAdapter {
  render(input: RenderInput): { stdout: string; stderr?: string };
}
```

The orchestrator's responsibility ends at producing `RenderInput`. Adapters never call the API, never read state, never decide what data to load. They are pure transforms from a populated payload to terminal output.

`composeHandoffBrief()` and the header/usage renderer (`renderSessionHeader`) stay in shared modules — both adapters that render headers can call the shared helper. The principle: **shared logic → orchestrator helpers; per-platform-quirks-only → adapter**.

Locality property: the file you open to understand a behavior is the file you edit to change it. "How does Codex render?" → `adapters/codex.ts`. "How does the handoff brief get composed?" → orchestrator helper.

Note on deployment paths: the same `dist/hooks/*.js` set ships in the npm package, but `setup.ts` deploys to **three different filesystem locations** based on platform — Claude direct to `~/.claude/hooks/` (line 767), Gemini to `~/.purmemo/gemini-extension/scripts/` then registered via `gemini extensions link` (line 1059), Codex direct to `~/.codex/hooks/` (line 1175). All three sites stamp `__HOOKS_VERSION__` independently. The adapter pattern doesn't change any of this — it changes only what's *inside* the deployed `purmemo_recall.js`.

The same pattern that works for ESLint formatters works here. Three platforms today, room for any future CLI tomorrow with no risk to the three that already work.

### Safety contract (all adapters)

Every adapter `render()` MUST:
- Wrap user-facing logic so a thrown exception returns a minimal `{ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName } }) }` payload — **never block session start**.
- Never throw out of `render()`. Errors go to `stderr` via `errLog()` and are swallowed.
- Be a pure function of `RenderInput` — no API calls, no filesystem reads, no state writes. The orchestrator owns all side effects.

## Consequences

### Positive

- **Single source of truth restored.** The Codex compact mode currently orphaned at `~/.codex/hooks/purmemo_recall.js` lands in `adapters/codex.ts` and survives `purmemo --update`.
- **Future Gemini upstream fix is one-line.** When [google-gemini/gemini-cli#26395](https://github.com/google-gemini/gemini-cli/issues/26395) ships, drop the stderr branch from `adapters/gemini.ts` and return to the standard `additionalContext + systemMessage` shape — no orchestrator changes.
- **Future Codex upstream fix needs zero work.** When [openai/codex#17532](https://github.com/openai/codex/issues/17532) ships, the existing adapter just starts firing reliably in interactive TUI. No code change needed.
- **Adding a platform = one new file.** Cursor, Aider, etc. each become an adapter without touching anything that already works.
- **Each adapter is unit-testable.** A `tests/hooks/adapters/codex.test.ts` with fixture inputs becomes possible. Today, none of the platform behavior has tests.
- **Read time matches change time.** "How does Codex render?" becomes "open `adapters/codex.ts`" — not "search for `=== 'codex'` in 370-line `purmemo_recall.ts`."

### Negative

- **One-time refactor.** ~1-2 hours of moving code, plus smoke-test against all three platforms before commit.
- **Three small files vs one larger file.** A reader has to know the registry exists. Mitigated by the `adapters/index.ts` registry being the single map.

### Neutral

- **`setup.ts` install path unchanged.** `installHooks()` (Claude), `installGeminiExtension()`, `installCodexHooks()` still copy the same `dist/hooks/*.js` set. The three independent version-stamping sites at `setup.ts:777`, `:1073`, `:1186` still apply — and now the broken-out adapters can't drift from source the way the morning hand-deploy did.
- **Bundle size delta is negligible.** Splitting one file into 5 small files compiles to roughly the same total bytes after `tsc`.

## Implementation Plan

0. **Backup the orphan-Codex compact build first.** `cp ~/.codex/hooks/purmemo_recall.js /tmp/purmemo_recall.codex-orphan.bak`. Step 4 ports from this file, but a backup turns "destructive risk" into "recoverable."
1. Create `src/hooks/adapters/types.ts` with `RenderInput` + `PlatformAdapter` interfaces.
2. Extract Claude logic from current `purmemo_recall.ts` into `adapters/claude.ts`.
3. Extract the (uncommitted) Gemini stderr branch into `adapters/gemini.ts`.
4. **Port** Codex compact-mode logic from `~/.codex/hooks/purmemo_recall.js` (lines 23, 37-41 for `truncateTitle` + `CODEX_TITLE_MAX`; lines 193-216 for compact-mode branch; lines 246-252 for `(none)` payload + `visibleMessage` synthesis) into `adapters/codex.ts`. The JS is readable as-is — this is a translation, not reverse-engineering.
5. Create `adapters/index.ts` registry: `export const adapters: Record<Platform, PlatformAdapter> = { claude, gemini, codex }`.
6. Strip platform branches out of `purmemo_recall.ts` — leaves orchestrator + final adapter dispatch (~150 lines).
7. Smoke-test each adapter via `echo '<input>' | node dist/hooks/purmemo_recall.js` with platform-detection inputs for Claude, Gemini, Codex. **Success criteria** (must all pass before commit):
   - **Claude:** stdout JSON contains `hookSpecificOutput.additionalContext` (handoff brief) AND `systemMessage` (header reads `pūrmemo v15.7.16 · ... memories`, no `__HOOKS_VERSION__` literal). No stderr output.
   - **Gemini:** stdout JSON contains `systemMessage: ''` (empty). stderr contains the visible banner with header + numbered memory list.
   - **Codex:** stdout JSON contains `hookSpecificOutput.additionalContext` as a single-line string with `|` delimiters and `truncateTitle` cap of 30/34 chars. `systemMessage: '(none)'` (sentinel, not empty). 3-memory preview, not 5.
8. Run `purmemo --update` to deploy through the official install path (re-stamps `__HOOKS_VERSION__` at all three sites, restores parity, overwrites the orphan-Codex compact build with the new properly-sourced one).
9. Commit the Gemini stderr workaround that has been sitting uncommitted in working tree (it gets folded into `adapters/gemini.ts` during step 3, but the original branch on `purmemo_recall.ts` should be reverted as part of the same PR).

## Rollback Strategy

- **If smoke tests fail (step 7):** Don't deploy. The refactor lives only in working tree.
- **If post-deploy a platform breaks:** `git revert` the refactor commit and `purmemo --update`. The pre-refactor unified hook resumes immediately. Codex compact mode would degrade to Claude's full output (cosmetic only — the warning-collapse and newline-flatten still happen, but no functional break) until the orphan backup is restored from `/tmp/purmemo_recall.codex-orphan.bak`.
- **If `purmemo --update` itself fails on a user's machine:** The previous deployed `purmemo_recall.js` stays in place. Hooks continue running the old code. No user-visible regression — just no new behavior. (This is `setup.ts`'s existing semantics; the adapter pattern doesn't change it.)

## Migration risk

~5 known users have purmemo-mcp registered via `npx -y purmemo-mcp@latest` in their MCP configs (per ADR-035 context). After this refactor + a published version, their next `--update` swaps "monolith with Gemini branch" → "orchestrator + 3 adapters." The safety contract above (every `render()` returns a minimal payload on exception) means even a runtime error in an adapter cannot block session start. Empty-list / null-account / fetch-failure paths are already handled by the orchestrator (existing behavior preserved).

## Follow-ups (post-merge, not part of this ADR)

- Write `tests/hooks/adapters/*.test.ts` with fixture-driven tests for each renderer.
- Extract `composeHandoffBrief()` into its own `src/hooks/handoff.ts` if it grows further (currently fine inside `purmemo_recall.ts`).
- Consider an `adapters/cursor.ts` stub when Cursor ships hooks support.

## Status of related work

- Today's `__HOOKS_VERSION__` placeholder bug (broke Claude header — `pūrmemo v__HOOKS_VERSION__` for ~1h) was patched in-place via `sed` on `~/.claude/hooks/purmemo_lib.js`. The proper fix is step 8 above (re-install through `setup.ts`'s stamping path, all three sites at once).
- Codex compact-mode logic at `~/.codex/hooks/purmemo_recall.js` is the only place this code currently exists. **Do not run `purmemo --update` until steps 0+4 lands**, or the compact mode will be lost. Step 0 backs up the orphan; step 4 ports it; step 8 then safely re-deploys.

## Sources

- [ESLint Custom Formatters](https://eslint.org/docs/latest/extend/custom-formatters) — canonical "shared core, pluggable renderer" pattern in JS tooling.
- [oclif Plugins](https://oclif.io/docs/plugins/) — reviewed and rejected as over-engineered for our 3-adapter scope.
- [Plugin Architecture, Adapter Pattern](https://devleader.substack.com/p/plugin-architecture-adapter-pattern) — adapter pattern reference.
- [openai/codex#17532](https://github.com/openai/codex/issues/17532) — Codex interactive TUI hook bug (workaround in adapter).
- [google-gemini/gemini-cli#26395](https://github.com/google-gemini/gemini-cli/issues/26395) — Gemini double-render bug (workaround in adapter).

## Appendix: How We Arrived Here — Timeline

This ADR isn't a greenfield design — it's the answer to a 6-week pattern of platform drift. Recorded for the future reader so the reasoning isn't lost.

### Phase 0 — Founding constraint: "implement the elegant solution" (March 22, v15.1.0)
- **2026-03-22** — 12-hour session diagnosing post-Hono-migration hook breakage. The user's repeated mandate, recorded verbatim in `2338fb45`: *"Knowing everything you know now, scrap this and implement the elegant solution."* Result: 8 hooks across 5 files with duplicated code → 4 files (`purmemo_recall`, `purmemo_capture`, `purmemo_first_message`, `purmemo_intelligence`) with shared `purmemo_lib`. Commit `1527066`. **This is the architectural ancestor of ADR-037** — the same instinct (consolidate, share, isolate concerns) now extended one layer deeper at the rendering boundary.
- **2026-03-19** — ADR-017 (MCP Distribution Parity) established the principle that all distribution surfaces must update together. This stayed true for the *npm package*; it did not anticipate per-platform *renderer* drift. (Ref: `0bb28c3c`.)

### Phase 1 — Single platform (Claude only, post-rewrite)
- **2026-03-22 → 2026-03-28** — Hooks shipped exclusively for Claude Code. `purmemo_recall.ts`, `purmemo_lib.ts`, `purmemo_first_message.ts`, `purmemo_intelligence.ts` all assumed one renderer (Claude). The architecture was correct *for one platform*. (Ref: `13bfcfe0` Passive Capture & Recall System.)

### Phase 2 — Cross-platform expansion
- **2026-03-28** — Cross-platform feature parity work began. Released v15.1.6 → v15.2.3. Built `npx purmemo-mcp@latest init` as the single command that wires every platform. **First moment Gemini and Codex entered the codebase.** Initial assumption: same hook payload schema works everywhere — verified for `hookSpecificOutput` shape, NOT verified for renderer behavior. Commits `8fafc92` (init auto-configures all three), `836d76e` (cross-platform purmemo: Gemini extension + Codex skill), `f2d30d0` (Gemini extension auto-link), `7b03044` (init updates outdated hooks), `ffe5689` (platform-name fix: `'gemini'` not `'gemini-cli'`). (Ref: `449ca878` Cross-Platform Feature Parity.)
- **2026-03-28** — ADR-025 V2 Intelligence Extraction Schema landed. `composeHandoffBrief()` formalized into the 5-layer compaction (intent / decisions / open-loops / context / content). This is the platform-agnostic core that the new architecture preserves verbatim. (Ref: `58e2becf`.)

### Phase 3 — Capture retirement & Gemini-specific debugging
- **Pre-Apr 12** — v15.3.0 (commit `9291ee5`): *"retire purmemo_capture, AMP is canonical capture path"*. **Platform-wide architectural decision** — capture-via-hook removed everywhere, not just Gemini. PurmemoAMP became the single source of truth for session capture across all three CLIs. This is why `installCodexHooks()` (line 1194-1198) now registers ONLY SessionStart + UserPromptSubmit, not PostToolUse/Stop — the comment explicitly cites the April Gemini duplicate-memory incident as the reason this principle exists.
- **Earlier — chunking precedent.** Commit `a0e3829`: *"remove client-side chunking from hooks — single-row living documents"*. Same instinct: extract concerns from the hook into the API. ADR-037's adapter extraction is the third instance of this principle (chunking → API; capture → AMP; rendering → adapter).
- **2026-04-12** — Gemini CLI session debugging *residual* duplicates and cloud sync edge cases (capture-hook was already gone — these were sync-layer issues). (Refs: `4f8f2b54`, `6544071e`, `a9c946e6` — Gemini CLI sessions Apr 12.) This was the **first observation** that Gemini's hook semantics aren't Claude's at the renderer layer; treated as a one-off carve-out at the time, not yet a structural signal.

### Phase 4 — CLI distribution UX (April 30 → May 2)
- **2026-04-30** — ADR-035 lands: one-line curl installer (`curl purmemo.ai/install | sh`). Vibe-coder UX bar. (Ref: `2585d95f`.)
- **v15.6.0** (`9cd229b`) — Multi-account profiles + `purmemo` bin + `--update`.
- **v15.7.0** (`48a6d17`) — `purmemo --update` self-upgrades global installs.
- **v15.7.1** (`2ffde6c`) — `purmemo` interactive runs `init`, not server.
- **v15.7.6** (`6f6d956` + `0f25534`) — Live SessionStart header (tier + usage + upsell) + ✨ updated badge. Cosmetic surface area grew significantly.
- (Refs: `93defb69` v15.6.0 → v15.7.2 Part 2/2; `6f14c4a8` v15.7.5 → v15.7.10.)

### Phase 5 — Gemini double-banner discovery (May 2)
- **v15.7.11** (`556e476`) — Gemini extension auto-update parity. `installGeminiExtension()` wired into `reconcileInstallation()`.
- **v15.7.12** (`28b0bc5`) — First "single-block SessionStart on Gemini" attempt: dropped `additionalContext` on Gemini path. Did not fix the duplicate; reduced damage but cosmetic issue persisted.
- **v15.7.13** (`aa53f39`) — Tried `suppressOutput: true` on Gemini. **Did not work.** Misread of `AppContainer.tsx` source — the `!suppressOutput` guard was on `debugLogger.warn`, NOT the visible UI render at line 500.
- **v15.7.14** (`9e89d35`) — Reverted v15.7.13. Filed [google-gemini/gemini-cli#26395](https://github.com/google-gemini/gemini-cli/issues/26395) with full source-level analysis: BOTH render paths (`AppContainer.tsx:499-508` and `hookEventHandler.ts:463-468`) check `result.systemMessage` directly, neither honors `suppressOutput`. **Structural upstream bug — no clean fix from hook author side.** Documented as known cosmetic issue.

### Phase 6 — Codex hook integration (May 2 → 3 morning)
- **v15.7.15** (`1b21fed`) — Codex hooks shipped. Extended `Platform` type from `'claude' | 'gemini'` to `'claude' | 'gemini' | 'codex'`. New `installCodexHooks()` + `codexHooksExist()` + `codexHooksOutdated()`. Wired into `reconcileInstallation()`. Codex routed into the same output branch as Claude — schema-level assumption (matching Codex docs on `hookSpecificOutput.additionalContext` nesting) was correct, renderer-level assumption (that the same payload would render acceptably) was not. The TUI's `warning:` collapse + newline flatten weren't documented; only discoverable empirically.
- **v15.7.16** (`71b35b6`) — Codex `[features] codex_hooks = true` feature flag fix. Without flag, `hooks.json` silently ignored. `enableCodexHooksFeatureFlag()` added to `installCodexHooks()` (`setup.ts:1257-1279` — idempotent, inserts under existing `[features]` or appends new block).
- **v15.7.16 reality check** — Even with flag, interactive Codex TUI didn't fire hooks. Probe at `/tmp/codex-probe.sh` confirmed: `codex exec` fires hooks, `codex` (TUI) does not. **Confirmed upstream bug** — commented on [openai/codex#17532](https://github.com/openai/codex/issues/17532) with empirical reproduction. (Ref: `1b5bdc6b` CLI Distribution v15.7.x; `92625f30` Codex Hook Bug Reproduction; `c2bad585` Codex Platform Enum Test.)

### Phase 7 — Codex platform enum fix (May 3 morning, ~14:08Z)
- Codex saves were 422'ing on both CREATE and PATCH — `codex` missing from both `createSchema` and `updateSchema` Zod validators in `purmemo-api/src/routes/memories.ts:32, :79`. Commit `48aec1b` (`fix(codex): codex platform support + snapshot_sources timeout + insight serialization`) added codex to both. Render API service `srv-d24gd83uibrs73bu8hng` deploy `dep-d7rlcfflk1mc73dgq6gg` live at 14:07:44Z. (Refs: `c2bad585` final verification; `1cfc4128` Gemini parallel verification.)

### Phase 8 — The morning that surfaced the architectural debt (May 3, 06:39 → 09:00)
This is the immediate context for ADR-037. Sequence reconstructed from purmemo memory timestamps + filesystem mtimes.

- **06:39 PT** (`92625f30`) — User opened **Codex CLI** to debug TUI hook bug directly, since Codex is where the bug lives ("since you codex are the one having the bug i figure you can resolve it"). Empirically reproduced: `codex exec` fires hooks, interactive `codex` TUI does not. Confirmed upstream bug `openai/codex#17532`.
- **~06:50** (saved as `92625f30`) — User asked to save *as new memory*, not living-document update: "save as new memory since this is in codex i dont want you saving as a living document in purmemo". Realized then that purmemo recall is unified across CLIs — Gemini and Codex changes affect each other through the shared codebase.
- **06:55 PT** (`4db52e6f`) — User opened **Gemini CLI** to debug double-banner. Initial wrong theory (rooted in misreading `AppContainer.tsx`'s `suppressOutput` guard) led to v15.7.13 attempt. After v15.7.14 revert, applied the surgical fix: **stderr bypass + empty `systemMessage`**. Manually copied `dist/hooks/*.js` → `~/.claude/hooks/`. **Failure mode 1:** the manual copy bypassed `setup.ts:777` version-stamping — the placeholder substitution lives in the install path, not the build.
- **~07:00 PT** (file mtime `~/.claude/hooks/purmemo_recall.js`: May 3 07:00) — Claude hooks redeployed with the Gemini stderr branch. `~/.claude/hooks/purmemo_lib.js` now contains literal `__HOOKS_VERSION__` placeholder.
- **~07:00 → 07:44 PT** (file mtime `~/.codex/hooks/purmemo_recall.js`: May 3 07:44) — In Codex CLI session, hand-edited `~/.codex/hooks/purmemo_recall.js` into a **Codex-specialized compact build**: 3-memory preview, `truncateTitle(44)`, `(none)` warning payload, no header, no `getAccountSnapshot` import (262 lines vs Claude's 361). **Failure mode 2:** the divergent build exists nowhere in source — the next `purmemo --update` will silently overwrite it. (Ref: `c436fd0b` Codex SessionStart Hook - Working Version + Formatting Constraints.)
- **~08:00 PT** (screenshot filename: `Screenshot 2026-05-03 at 8.07.55 AM.png`) — User opened a fresh Claude session. Banner rendered `pūrmemo v__HOOKS_VERSION__` — placeholder unstamped. User: *"i tried to fix the double banner in gemini but it broke how claude now displays it banner."*
- **~08:15 PT** — Patched in-place via `sed -i '' "s/__HOOKS_VERSION__/15.7.16/g" ~/.claude/hooks/purmemo_lib.js`. Cosmetic restored. Structural problem (3 deployed hooks, 2.5 source branches, 1 orphan compact build) unresolved.
- **~08:30 PT** — User asked: *"is this the most elegant way of doing this hook since it seems like each platform has a different cork."*
- **~08:45 PT** — User asked: *"should we research this so that we have the best mental model and maybe create a ADR?"* → This ADR.

### The signal in the noise
Three failure modes in 90 minutes, all with the same root cause:
1. **Gemini fix touched the unified path** → forced manual deploy → bypassed stamping → Claude broke.
2. **Codex fix could not live in the unified path** (compact mode, `(none)` payload, no header all conflict with Claude's expectations) → hand-edited fork → drift from source.
3. **`--update` would now wipe the Codex fork** → silent regression on next normal install.

Each fix in isolation was correct. The architecture made every fix dangerous. **That's the problem ADR-037 solves.**

### Files for the next reader

**Source (purmemo-mcp repo):**
- `src/hooks/purmemo_recall.ts` — current monolith (working tree has uncommitted Gemini stderr branch — `git status` shows `modified` on this file as of 2026-05-03)
- `src/hooks/purmemo_lib.ts` — `Platform` type, `detectPlatform()`, `getPaths()`, `HOOKS_VERSION` constant (the `__HOOKS_VERSION__` placeholder lives at line 49). Unchanged by this ADR.
- `src/setup.ts:767-783` — `installHooks()` Claude install + stamp at line 777
- `src/setup.ts:1059-1078` — `installGeminiExtension()` Gemini install + stamp at line 1073
- `src/setup.ts:1175-1192` — `installCodexHooks()` Codex install + stamp at line 1186
- `src/setup.ts:1257-1279` — `enableCodexHooksFeatureFlag()` (idempotent `[features] codex_hooks = true`)

**Deployed runtime (per-user):**
- `~/.claude/hooks/purmemo_recall.js` — current deployed Claude hook (361 lines, in-place version-patched 2026-05-03 ~08:15)
- `~/.purmemo/gemini-extension/scripts/purmemo_recall.js` — Gemini deployment path (registered with Gemini via `gemini extensions link`). NOT under `~/.gemini/`.
- `~/.codex/hooks/purmemo_recall.js` — **the only place Codex compact mode currently exists** (262 lines, hand-edited 2026-05-03 07:00 → 07:44). DO NOT run `purmemo --update` until steps 0+4 of the implementation plan extract this into `adapters/codex.ts`. Step 0 backs it up to `/tmp/purmemo_recall.codex-orphan.bak` first.
- `~/.codex/hooks.json` — Codex hook registration (matcher `startup|resume`, statusMessage `"Loading purmemo memory…"`)
- `~/.codex/config.toml` — must contain `[features]\ncodex_hooks = true` (idempotently maintained by `enableCodexHooksFeatureFlag()`)

**Memory IDs for full context:**
- `2338fb45` — March 22 elegant-rewrite mandate (12-hour session, Phase 0 ancestor)
- `449ca878` — March 28 cross-platform parity work (v15.1.6 → v15.2.3)
- `1b5bdc6b` — v15.7.x story (Gemini extension auto-update, Codex hooks, May 2-3)
- `4db52e6f` — Gemini double-banner fix conversation
- `92625f30` — Codex hook bug reproduction (TUI vs `codex exec`)
- `c436fd0b` — Codex SessionStart Hook working version + formatting constraints (the orphan-build conversation)
- `c2bad585` — codex platform enum verification (createSchema/updateSchema fix)
- `ec91a8c0` — snapshot_sources timeout + insight serialization fixes (parallel May 3 work)

**Upstream issues (not ours to fix, workaround in adapters):**
- [google-gemini/gemini-cli#26395](https://github.com/google-gemini/gemini-cli/issues/26395) — double-render
- [openai/codex#17532](https://github.com/openai/codex/issues/17532) — TUI doesn't fire hooks
