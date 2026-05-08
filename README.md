# pūrmemo

[![npm version](https://badge.fury.io/js/purmemo-mcp.svg)](https://www.npmjs.com/package/purmemo-mcp)
[![npm downloads](https://img.shields.io/npm/dm/purmemo-mcp.svg)](https://www.npmjs.com/package/purmemo-mcp)
[![Tests](https://github.com/purmemo-ai/purmemo-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/purmemo-ai/purmemo-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Memory for your AI tools.** Claude remembers who you are, what you're working on, and what you said last time — across every session, on every platform.

> Just want it in ChatGPT or Claude.ai in your browser? Get the [Chrome Extension](https://chromewebstore.google.com/detail/p%C5%ABrmemo/moemdiomegehfjgjahfgjlbmikhnbhca) instead.

---

## Install in 30 seconds

### 1. Paste this into your terminal

**Mac or Linux:**
```bash
curl -fsSL https://app.purmemo.ai/install | sh
```

**Windows (PowerShell):**
```powershell
irm https://app.purmemo.ai/install.ps1 | iex
```

That's it for installing. The script handles everything — it'll install Node if you don't have it, set up the `purmemo` command, and tell you when it's done.

### 2. Type `purmemo`

```bash
purmemo
```

Your browser opens. Sign in (or create a free account). Close the tab when it says you're done.

### 3. Restart Claude

Quit and reopen Claude Desktop (or Claude Code). pūrmemo is now connected.

**You'll know it worked** when your next Claude session opens with a header like:

```
pūrmemo v15.7.20 · you@example.com · Free · 0 memories
```

Try saying "save this" at the end of a conversation, or "what was I working on?" at the start of a new one.

---

## If something goes wrong

**`purmemo` command not found?** Close and reopen your terminal, then try again. New commands sometimes need a fresh shell.

**You see "Failed to read token" or "bad decrypt"?** Run:
```bash
purmemo --update && purmemo init
```
This clears any stale credentials and signs you back in. (Fixed in v15.7.20+ — if you're on an older version, this is a one-time thing.)

**Anything else?** Open an issue at [github.com/purmemo-ai/purmemo-mcp/issues](https://github.com/purmemo-ai/purmemo-mcp/issues) — we read every one.

---

## What it does

- **Remembers everything** — save any conversation, recall it later by typing what you remember about it.
- **Knows who you are** — your role, your projects, your stack — loaded automatically into every new session.
- **Works everywhere** — Claude Code, Claude Desktop, Cursor, Windsurf, Zed, anything that speaks MCP.

Three slash commands you'll use most:

| You type | What happens |
|----------|-------------|
| `/save` | Saves this conversation. Use the same title later → updates the same memory. |
| `/recall <topic>` | Search your memories in plain English. |
| `/context` | At the start of a session — loads who you are and what you were last working on. |

---

## Other ways to install

<details>
<summary><b>I already have Node.js</b></summary>

```bash
npm install -g purmemo-mcp && purmemo
```

Or, run it once without installing globally:

```bash
npx purmemo-mcp@latest init
```

</details>

<details>
<summary><b>Claude Desktop — hosted (recommended, no setup)</b></summary>

Open Claude Desktop → Settings → Developer → Edit Config and add:

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

Restart Claude Desktop. You'll be prompted to sign in via OAuth on first use.

</details>

<details>
<summary><b>Claude Desktop — local (advanced)</b></summary>

Get your API key from [app.purmemo.ai](https://app.purmemo.ai) → Settings → API Keys, then edit:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "purmemo": {
      "command": "npx",
      "args": ["-y", "purmemo-mcp"],
      "env": { "PURMEMO_API_KEY": "your-api-key-here" }
    }
  }
}
```

Restart Claude Desktop after saving.

</details>

<details>
<summary><b>Cursor / Windsurf / Zed</b></summary>

**Cursor** — edit `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "purmemo": { "command": "npx", "args": ["-y", "purmemo-mcp"], "env": { "PURMEMO_API_KEY": "your-api-key" } } } }
```

**Windsurf** — edit `~/.codeium/windsurf/mcp_config.json` (same shape as above).

**Zed** — edit `~/.config/zed/settings.json`, add under `context_servers`:
```json
{ "context_servers": { "purmemo": { "command": { "path": "npx", "args": ["-y", "purmemo-mcp"], "env": { "PURMEMO_API_KEY": "your-api-key" } } } } }
```

</details>

---

## Pricing

| Plan | Price | Recalls | Saves |
|------|-------|---------|-------|
| Free | $0 | 50/month | Unlimited |
| Pro | $19/month | Unlimited | Unlimited |

---

## For developers

Looking for the technical stuff? It's all here:

- **[Tools, resources, prompts reference](docs/REFERENCE.md)** — every MCP tool the server exposes (`save_conversation`, `recall_memories`, `commit`, `snapshot`, `run_workflow`, etc.)
- **[Living document semantics](docs/LIVING_DOCUMENTS.md)** — `mode='append'` vs `mode='replace'`, chunking behavior, ADR-036/038 details.
- **[Identity layer](docs/IDENTITY.md)** — the cognitive fingerprint that loads into every session.
- **[Architecture decisions (ADRs)](docs/adr/)** — every design decision, with context and trade-offs.
- **[Source for the install scripts](scripts/)** — read before running, if you want.

---

## Links

- **[Dashboard](https://app.purmemo.ai)** — view and manage memories
- **[Chrome Extension](https://chromewebstore.google.com/detail/p%C5%ABrmemo/moemdiomegehfjgjahfgjlbmikhnbhca)** — for ChatGPT, Claude.ai, Gemini in browser
- **[Privacy Policy](https://purmemo.ai/privacy)** — encrypted in transit and at rest, never shared
- **[Support / Issues](https://github.com/purmemo-ai/purmemo-mcp/issues)**

---

## License

The MCP connector code in this repo is [MIT licensed](./LICENSE). The pūrmemo platform, API, and backend are proprietary.
