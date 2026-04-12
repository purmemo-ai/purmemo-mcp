# pūrmemo MCP Server

[![npm version](https://badge.fury.io/js/purmemo-mcp.svg)](https://www.npmjs.com/package/purmemo-mcp)
[![npm downloads](https://img.shields.io/npm/dm/purmemo-mcp.svg)](https://www.npmjs.com/package/purmemo-mcp)
[![Tests](https://github.com/purmemo-ai/purmemo-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/purmemo-ai/purmemo-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io)

**Claude knows who you are before you say a word.**

pūrmemo gives your AI a persistent memory and identity layer — your role, expertise, active projects, and conversation history — available instantly in every session, across every platform.

> **Using ChatGPT, Claude.ai, or Gemini in browser?** Get the [Chrome Extension](https://purmemo.ai/extension) instead.

---

## What It Does

- **Remembers everything** — save conversations, decisions, and context; search them later with natural language
- **Knows who you are** — your role, expertise, tools, and active projects load automatically at session start
- **Works everywhere** — Claude Code, Claude Desktop, Cursor, Windsurf, Zed, and any MCP-compatible platform

---

## Quick Start

### One command:

```bash
npx purmemo-mcp@latest init
```

This opens your browser to sign in, configures the MCP server, and installs hooks + slash commands (`/save`, `/recall`, `/context`). That's it.

### Manual Setup (alternative)

If you prefer to configure manually, or you're not using Claude Code:

<details>
<summary><b>Claude Code (Terminal) — manual</b></summary>

1. Get your API key from [app.purmemo.ai](https://app.purmemo.ai) → Settings → API Keys

```bash
claude mcp add purmemo -e PURMEMO_API_KEY=your-api-key-here -- npx -y purmemo-mcp
```

Verify it connected:

```bash
claude mcp list
# purmemo: npx -y purmemo-mcp - ✓ Connected
```

</details>

<details>
<summary><b>Claude Desktop (Remote MCP — Recommended)</b></summary>

Use pūrmemo's hosted MCP server — no API key setup required, authenticates via OAuth:

1. Open Claude Desktop → Settings → Developer → Edit Config
2. Add this configuration:

```json
{
  "mcpServers": {
    "purmemo": {
      "url": "https://mcp.purmemo.ai/mcp/messages",
      "transport": "streamable-http"
    }
  }
}
```

3. Restart Claude Desktop
4. You'll be prompted to sign in via OAuth

</details>

<details>
<summary><b>Claude Desktop (Local NPX)</b></summary>

Edit your config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "purmemo": {
      "command": "npx",
      "args": ["-y", "purmemo-mcp"],
      "env": {
        "PURMEMO_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

</details>

<details>
<summary><b>Cursor IDE</b></summary>

Edit `~/.cursor/mcp.json` (macOS) or `%USERPROFILE%\.cursor\mcp.json` (Windows):

```json
{
  "mcpServers": {
    "purmemo": {
      "command": "npx",
      "args": ["-y", "purmemo-mcp"],
      "env": {
        "PURMEMO_API_KEY": "your-api-key-here"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf IDE</b></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "purmemo": {
      "command": "npx",
      "args": ["-y", "purmemo-mcp"],
      "env": {
        "PURMEMO_API_KEY": "your-api-key-here"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Zed Editor</b></summary>

Add to `~/.config/zed/settings.json` under the `context_servers` key:

```json
{
  "context_servers": {
    "purmemo": {
      "command": {
        "path": "npx",
        "args": ["-y", "purmemo-mcp"],
        "env": {
          "PURMEMO_API_KEY": "your-api-key-here"
        }
      }
    }
  }
}
```
</details>

### Start Using

```
You: "What's the project status?"
Claude: Based on your identity and recent memories:
  You're a founder working on a B2B SaaS product.
  Recent work: pūrmemo (15 sessions), auth refactor (3 sessions)
  Last session: "Fixed JWT refresh token rotation"
```

---

## What You Get

### Resources (attach to any conversation via the `+` button)

| Resource | What it contains |
|----------|-----------------|
| `memory://me` | Your identity: role, expertise, tools, active projects, what you're working on |
| `memory://context` | Your 5 most recent conversation summaries |
| `memory://projects` | All projects you've saved memories about, grouped and sorted by recency |
| `memory://{id}` | Full content of any specific memory by ID |

**Example — attach `memory://me` at session start:**

```
You are working with:
**Chris** — Founder, B2B SaaS
Expertise: product, fullstack, ai
Tools: cursor, claude, supabase
Style: systems thinker

Recent work:
- pūrmemo (15 recent sessions)
- auth-refactor (4 recent sessions)

Working on: MCP Resources + Prompts feature
```

No re-explaining who you are. No repeating your stack. Just continue.

### Prompts (conversation starters in the `+` menu)

| Prompt | What it does |
|--------|-------------|
| `load-context` | Load your full identity and recent memories to start a session |
| `save-this-conversation` | Save the current conversation as a living document |
| `catch-me-up` | Get a summary of recent work across all projects |
| `weekly-review` | Review the week's progress and plan what's next |

---

## Tools

### Core

| Tool | Description |
|------|-------------|
| `save_conversation` | Save conversations with smart titles and context extraction |
| `save_artifact` | Save artifacts (research reports, tables, specs) linked to conversations |
| `recall_memories` | Search memories with natural language |
| `get_memory_details` | Get full details of a specific memory |
| `discover_related_conversations` | Find related discussions across platforms |
| `get_user_context` | Load your identity profile and recent work context |

### Workflows

| Tool | Description |
|------|-------------|
| `run_workflow` | Run structured workflows (PRD, debug, sprint, deploy, etc.) |
| `list_workflows` | List all available workflows by category |

### Community

| Tool | Description |
|------|-------------|
| `share_memory` | Set memory visibility (private, unlisted, or public) |
| `recall_public` | Search public community memories (free for all tiers) |
| `get_public_memory` | Get the full content of a shared memory |
| `report_memory` | Report inappropriate public content |

### Tasks & Investigation

| Tool | Description |
|------|-------------|
| `get_next_task` | Get the next pending task from your queue |
| `complete_task` | Mark a task complete with optional notes |
| `generate_handoff_brief` | Generate a handoff brief for the current session |
| `save_test_result` | Save a test run result linked to a conversation |
| `get_acknowledged_errors` | Fetch acknowledged production errors awaiting investigation |
| `save_investigation_result` | Save error investigation results for audit trail |

**`get_user_context` in action:**

```
You: "What have I been working on?"
Claude: [calls get_user_context]

Your profile: Founder · B2B SaaS · fullstack/ai/product
Active projects:
  • pūrmemo — "MCP server resources and prompts" (15 sessions)
  • auth-refactor — "JWT refresh token fix" (4 sessions)
Working on: MCP Resources + Prompts feature
```

---

## Identity Layer

pūrmemo maintains a **cognitive fingerprint** — a persistent profile of who you are that loads automatically into every session.

Set it once at [app.purmemo.ai](https://app.purmemo.ai) → Settings → Identity:

- **Role** — founder, engineer, designer, researcher, ...
- **Domain** — your primary field (B2B SaaS, ML research, design systems, ...)
- **Expertise** — your key skills (product, fullstack, ai, ...)
- **Tools** — what you work with (cursor, claude, supabase, ...)
- **Work style** — how you think (systems thinker, iterative builder, ...)
- **Working on** — your current focus, updated per session

Once set, every new session inherits this context. Claude already knows your background, your stack, and what you were doing last time — without you having to explain it.

---

## Slash Commands (Claude Code)

After installing the slash commands (see Claude Code setup above):

| Command | What it does |
|---------|-------------|
| `/save` | Save the current conversation as a living document memory |
| `/recall [topic]` | Search past memories by topic |
| `/context` | Session startup — loads your identity + recent work |

The `/context` command is especially useful at the start of a session: it calls `get_user_context` and surfaces your identity and recent work so Claude already knows where you left off.

---

## Living Document Pattern

Same title = update, not duplicate. Build on memory over time:

```
You: "Save this as auth-refactor"
Claude: ✅ Saved — "auth-refactor" (new)

[... continue working across multiple sessions ...]

You: "Save as auth-refactor"
Claude: ✅ Updated — "auth-refactor" (3 updates, not 3 copies)
```

Long conversations? Auto-chunked at 100K+ characters and reassembled on recall.

---

## Pricing

| Plan | Price | Recalls | Saves |
|------|-------|---------|-------|
| Free | $0 | 50/month | Unlimited |
| Pro | $19/month | Unlimited | Unlimited |

---

## Links

- [Dashboard](https://app.purmemo.ai) — View and manage memories
- [Chrome Extension](https://purmemo.ai/extension) — For ChatGPT, Claude.ai, Gemini
- [Documentation](https://github.com/purmemo-ai/purmemo-mcp/tree/main/docs)
- [Support](https://github.com/purmemo-ai/purmemo-mcp/issues)

---

## Privacy

Your data is encrypted in transit (HTTPS) and at rest. It is never shared with third parties and is accessible only to you via your API key.

See our [Privacy Policy](https://purmemo.ai/privacy) for details.

---

## License

This MCP client package is [MIT licensed](./LICENSE) — you can use, fork, and modify it freely.

The **pūrmemo platform, API, and backend** are proprietary and closed-source. MIT applies only to the connector code in this repository, not to the service it connects to.
