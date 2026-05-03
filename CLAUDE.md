# Purmemo Project Instructions

## Session Startup: Get Project Context

**When starting a session after time away from the project, use `/context`** which automatically:
1. Recalls recent purmemo conversations about the project
2. Checks git status and recent commits
3. Reviews pending tasks (TODOs, FIXMEs)
4. Checks build/test status
5. Presents comprehensive "state of the project" report
6. Recommends next steps

This gives you (and the user) full context in seconds vs. manually reviewing everything.

## Context Gathering (Start of Every Task)

**Before starting ANY implementation or debugging work:**

### Option 1: Use the Research Workflow (RECOMMENDED)
Invoke the research workflow which automatically:
1. Gathers context about the task
2. Recalls relevant purmemo memories
3. Plans research strategy with krawlr_think
4. Executes search_web_ai for best practices
5. Gets Context7 library documentation
6. Presents a comprehensive research brief

To use: Type `/research` in the chat (slash command available in this project)

### Option 2: Manual Research (if skill not available)
**Execute these steps manually:**

1. **Recall relevant context** using `mcp__purmemo-local__recall_memories` or `mcp__purmemo-local__discover_related_conversations`
   - Search for related past conversations, decisions, and learnings
   - Review similar problems solved before
   - Gather architectural context and patterns used

2. **Research best practices** using `mcp__krawlr__*` tools:
   - **Step 1**: Use `krawlr_think` FIRST to analyze the task and plan the optimal search strategy
   - **Step 2**: Based on the thinking output, **ALWAYS use `search_web_ai` first** for superior quality (AI re-ranking, enhanced snippets, can scrape top results)
   - **Step 3**: Only fall back to basic `search_web` if `search_web_ai` fails
   - **Step 4**: Use `scrape_url` to get detailed docs from official sources when needed
   - Gather implementation guidance BEFORE coding to avoid unnecessary debugging

3. **Get library documentation** using `mcp__Context7__*` tools:
   - Use `resolve-library-id` to find the right library
   - Use `get-library-docs` to get up-to-date API documentation and examples
   - Reference current best practices and patterns

## During Implementation & Debugging

**When encountering bugs or errors, use the `/debug` slash command** which automatically:
1. Recalls similar past issues from purmemo
2. Plans debug strategy with krawlr_think
3. Researches error messages with search_web_ai
4. Checks Context7 for library-specific solutions
5. Presents comprehensive debug brief
6. Documents the solution for future reference

**For ongoing development:**
- **For library usage**: Use Context7 to get accurate API documentation
- **For architectural decisions**: Use `/decide` command for structured decision-making with ADRs
- **For unfamiliar patterns**: Research with krawlr before implementing

This approach minimizes trial-and-error debugging by ensuring you have the best guidance upfront.

## Making Architectural Decisions

**When facing significant architectural or design decisions, use `/decide`** which:
1. Recalls past architectural decisions from purmemo
2. Plans research strategy with krawlr_think
3. Researches best practices with search_web_ai
4. Compares options using Context7 documentation
5. Creates Architecture Decision Record (ADR)
6. Saves to purmemo for future reference

**Use for:** Database selection, framework choices, architecture patterns, major refactors
**Creates:** Structured ADR documents that become valuable team knowledge

## Pre-Commit Review

**Before committing code, use `/review`** which performs comprehensive checks:
1. **Security vulnerabilities** - SQL injection, XSS, auth issues, command injection, hardcoded secrets
2. **Code quality** - Code smells, best practices, error handling, DRY principles
3. **Test coverage** - Tests passing, new code tested, edge cases covered
4. **Documentation** - README, API docs, comments, CHANGELOG updates
5. **Dependencies** - Outdated packages, security vulnerabilities, config files
6. **Review report** - Comprehensive status with blockers, warnings, recommendations
7. **Saves to purmemo** - Creates audit trail and knowledge base

**Prevents:** Security vulnerabilities, technical debt, incomplete documentation
**Creates:** Safer, higher-quality commits with documented reviews

## Cross-Repo Auth Tests (CRITICAL)

**Before ANY change to login, OAuth, extension sign-in, or token delivery code, run `/test ext:auth`.**

The Chrome extension sign-in flow spans 4 codebases. These 42 tests verify the contracts between them:

| Command | What it tests | When to run |
|---------|--------------|-------------|
| `/test ext:auth` | All 42 cross-repo auth tests | Before ANY auth change |
| `/test ext:urls` | Extension URL params (popup, ext_id) | After extension code changes |
| `/test ext:oauth` | Backend OAuth redirect params | After backend OAuth changes |
| `/test ext:flow` | Frontend login/callback behavior | After frontend login changes |

**Test locations:**
- Extension: `chrome ext/chrome-extension-production/tests/signin-url-contracts.test.js` (24 tests)
- Backend: `purmemo-api/src/__tests__/oauth-redirect.test.ts` (10 tests)
- Frontend: `v1-mvp/frontend/e2e/auth-signin-flow.spec.ts` (8 tests)

## Pre-Deployment Checklist

**Before deploying to production (Render/Supabase), use `/deploy`** which:
1. **Runs full test suite** - Unit, integration, E2E tests must pass
2. **Verifies environment variables** - All required vars set in production
3. **Reviews recent logs** - Checks for existing issues (Render/Supabase logs)
4. **Database migration check** - Reviews migrations, creates backups, tests rollback
5. **Security audit** - Scans for vulnerabilities in dependencies
6. **Rollback plan** - Documents rollback strategy and triggers
7. **Deployment execution** - Provides deployment commands for Render/Supabase
8. **Post-deployment verification** - Health checks and smoke tests
9. **Saves deployment record** - Creates audit trail in purmemo

**Integrates with:** Render MCP (service status, logs), Supabase MCP (migrations, advisors)
**Prevents:** Failed deployments, data loss, production incidents
**Creates:** Reliable deployment process with full audit trail

## Error Investigation Workflow

**System Name**: AI-Powered Error Resolution System (see `v1-mvp/backend/ERROR_RESOLUTION_SYSTEM.md` for complete documentation)

**When production errors are acknowledged in the admin panel, use `/investigate-errors`** to:
1. **Fetch acknowledged errors** - Get errors waiting for investigation via MCP tool
2. **Research similar fixes** - Check purmemo for past similar errors
3. **Search best practices** - Use krawlr search_web_ai for solutions
4. **Get library docs** - Use Context7 for up-to-date API documentation
5. **Investigate codebase** - grep, read, git log to find root cause
6. **Propose fix** - Present analysis with confidence score and risk assessment
7. **Deploy when approved** - Edit, test, commit, push, monitor deployment
8. **Save investigation** - Store audit trail for learning from past fixes

**7-Step Investigation Process:**

**Step 1:** Fetch errors
```
get_acknowledged_errors(limit=10, level_filter="error", min_occurrences=3)
```

**Step 2:** Choose error to investigate (ask user)

**Step 3:** Research
- `recall_memories(query="<error keywords>")` - Check if we've seen this before
- `search_web_ai(query="<error message> solution")` - Find official solutions
- Context7 - Get library-specific documentation

**Step 4:** Investigate
- `grep` to find error source
- `read` to examine files
- `bash git log` to check recent changes

**Step 5:** Propose fix (template)
```markdown
## ROOT CAUSE
[Your analysis]

## FIX
Files to change:
- `file_path:line_number` (what to change)

## CONFIDENCE
[0.0-1.0] - [Explanation]

## RISK
[low/medium/high] - [Why]

## TEST PLAN
[How to verify]

## ROLLBACK
[How to rollback]
```

**Step 6:** Wait for approval ("Should I deploy this fix?")

**Step 7:** Execute
- Edit files
- Run tests
- Commit: `"Fix: <error message> [AI-Investigated]"`
- Push to GitHub (triggers Render auto-deploy)
- Save investigation: `save_investigation_result({...})`

**Integrates with:** Purmemo MCP (acknowledged errors, investigation storage)
**Creates:** Audit trail for learning, faster resolution of similar errors
**Saves:** 20+ hours/month on manual debugging

## Automatic Conversation Saving

When user says "save progress" or when significant milestones are reached, use the `/save` slash command which calls `save_conversation` with `mode: "append"`.

**HOW SAVES TARGET MEMORIES (post-ADR-036):**
- Same title (or explicit `conversationId`) → targets the existing memory
- `mode: "append"` (the /save default): server concatenates new content below existing with a timestamped separator (`\n\n--- UPDATE <ISO8601> ---\n\n`). Prior content stays visible inline.
- `mode: "replace"` (one-shot capture): overwrites existing content entirely. Prior content survives in the memory_events audit log but is not surfaced by recall.
- /save always uses append. Pass `mode: "replace"` only when the user explicitly asks for a fresh snapshot.

**YOUR RESPONSIBILITIES:**

1. **Use consistent, descriptive titles** following the format:
   - `[Project] - [Component/Feature] - [Type]`
   - Examples: "Purmemo - MCP Integration - Implementation"
   - Same title = same memory; append continues the thread

2. **Include the new content verbatim, not a summary**:
   - ALL new user messages exactly as written
   - ALL new assistant responses completely
   - ALL code blocks with full syntax
   - With append, you do NOT need to re-send already-saved content — only what's new since the last /save
   - Minimum 500 chars expected for the new content

3. **When to save**:
   - User explicitly asks "save progress" or "save this"
   - Significant milestones reached (feature complete, bug fixed, decision made)
   - End of session with meaningful work accomplished
   - Do this proactively without waiting for explicit request

4. **Use the /save slash command** — it sets `mode: "append"` automatically

The tool automatically:
- Routes to the existing memory at the same title/conversationId
- Appends with timestamp separator (or replaces if explicit `mode: "replace"`)
- Extracts project context, progress, relationships
- Generates smart metadata and tags
- Chunks large conversations (>15K chars) — but **append + chunking is rejected**: send a smaller delta (<15K) or use `mode='replace'`
- KNOWN CAVEAT: a doc that is small (single-memory) and later grows past 15K transitions to chunked storage at a new conversation_id space. Original single memory becomes orphaned. PR 4 / ADR-038 will unify the namespace; until then, anticipate by passing explicit `conversationId` for docs that will likely grow large.

## Project Context

This is the Purmemo project - a memory and context management system that uses MCP servers to help Claude remember and recall information across conversations.

## Architecture: Production vs Staging Routes

**CRITICAL**: The frontend has TWO environments on the SAME domain at DIFFERENT routes.

### Route Structure
```
app.purmemo.ai
├── /dashboard        → PRODUCTION (neural constellation frontend, all users)
└── /staging/*        → STAGING (prototyping environment, superadmin chris@purmemo.ai only)
    ├── /staging/clusters
    ├── /staging/constellation
    ├── /staging/graph
    ├── /staging/memories/[id]
    ├── /staging/timeline
    └── /staging/trash
```

### When User Says:
- **"Work on staging"** → Edit files in `app/staging/*` directory
- **"Work on production"** → Edit files in `app/dashboard` directory
- **"Deploy"** → Same command deploys BOTH environments (single Vercel deployment)

### Deployment
- **Single Vercel deployment** to app.purmemo.ai
- **Deploy command**: `vercel --prod` or `git push` (triggers auto-deploy)
- **Both environments** deployed together in single build
- **Codebase location**: `/Users/wivak/puo-jects/____active/purmemo/v1-mvp/frontend`

### Navigation
- **"Production" button** (top nav in staging pages) → routes to `/dashboard`
- **"Staging" link** (sidebar in production) → routes to `/staging` (superadmin only, controlled by `isSuperAdmin()`)

### Access Control
- **/dashboard** (production) → Visible to all authenticated users
- **/staging/** (staging) → Only visible to superadmin (chris@purmemo.ai) via `isSuperAdmin()` check

### Key Files with Route References
If you modify navigation or routing, check these files:
- `components/header.tsx` - Top navigation in staging pages
- `components/neural-constellation-v67.tsx` - Sidebar navigation in production (contains "Staging" link)
- `app/settings/page.tsx` - Back button navigation
- `components/error-boundary.tsx` - Error recovery navigation
