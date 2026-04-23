#!/usr/bin/env node
// @ts-nocheck — CLI setup utility, full typing in follow-up
/**
 * pūrmemo MCP Setup
 *
 * Handles two auth paths:
 *   1. PURMEMO_API_KEY in env (from dashboard install command) → save to auth.json
 *   2. Browser-open OAuth flow → poll for token → save to auth.json
 *
 * After auth, offers to install Claude Code hooks (auto-capture + recall).
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { execSync } from 'node:child_process';
import TokenStore from './auth/token-store.js';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const API_URL    = process.env.PURMEMO_API_URL || 'https://api.purmemo.ai';
const APP_URL    = process.env.PURMEMO_APP_URL || 'https://app.purmemo.ai';
const tokenStore = new TokenStore();

const HOOKS_DIR     = path.join(os.homedir(), '.claude', 'hooks');
const COMMANDS_DIR  = path.join(os.homedir(), '.claude', 'commands');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_SCRIPTS  = ['purmemo_lib.js', 'purmemo_recall.js', 'purmemo_first_message.js'];
const COMMAND_FILES = ['save.md', 'recall.md', 'context.md', 'purmemo.md'];
// purmemo_capture.js retired in v15.3.0 — AMP is the canonical capture path.
// See purmemoAMP's SessionMemoryExtractor + LocalCaptureServer. Legacy files are
// removed from existing installs by migrateRetireCapture() below.
const OLD_HOOK_SCRIPTS = ['purmemo_save.js', 'purmemo_heartbeat.js', 'purmemo_precompact.js', 'purmemo_session_start.js', 'hook-utils.js', 'purmemo_capture.js'];

const banner = `
╔═══════════════════════════════════════════╗
║                                           ║
║            🧠 pūrmemo MCP                 ║
║         Memory for your AI tools          ║
║                                           ║
╚═══════════════════════════════════════════╝
`;

const command = process.argv[2] || 'setup';

switch (command) {
  case 'setup':
  case 'init':   await runSetup();  break;
  case 'status': await runStatus(); break;
  case 'logout': await runLogout(); break;
  case 'hooks':  await runHooksOnly(); break;
  default:
    console.log(chalk.red(`Unknown command: ${command}`));
    console.log(chalk.gray('Usage: npx purmemo-mcp [setup|init|status|logout|hooks]'));
    process.exit(1);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function runSetup() {
  console.log(chalk.cyan(banner));

  // 1. Already authenticated?
  const existing = await tokenStore.getToken();
  if (existing?.access_token) {
    // If a new API key was passed in env, switch accounts automatically
    if (process.env.PURMEMO_API_KEY && process.env.PURMEMO_API_KEY !== existing.access_token) {
      console.log(chalk.yellow('⚡ Switching account…'));
      // fall through to the API key auth path below
    } else {
      // Fetch live tier from API — auth.json may be stale after a plan upgrade
      let info = await tokenStore.getUserInfo();
      try {
        const meRes = await fetch(`${API_URL}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${existing.access_token}` },
        });
        if (meRes.ok) {
          const me = await meRes.json() as { email?: string; tier?: string };
          if (me.tier && me.tier !== info?.tier) {
            // Persist fresh tier to auth.json
            await tokenStore.saveToken({ ...existing, user: { ...existing.user, email: me.email || existing.user?.email || '' }, user_tier: me.tier });
            info = { ...info, email: me.email || info?.email, tier: me.tier };
          }
        }
      } catch { /* non-blocking — use cached info if API unreachable */ }
      console.log(chalk.green('✅ Already connected!'));
      console.log(chalk.gray(`   Account: ${info?.email || 'unknown'}`));
      console.log(chalk.gray(`   Tier:    ${info?.tier || 'free'}`));
      console.log('');
      console.log(chalk.gray('To switch accounts: ') + chalk.cyan('npx purmemo-mcp logout') + chalk.gray(' then run setup again.'));
      console.log('');

      // Offer hooks even if already connected (they may not have them yet)
      if (hasOldHooks()) {
        console.log(chalk.yellow('⚡ Upgrading hooks to v2…'));
        await installHooks();
      } else if (!hooksAlreadyInstalled()) {
        await promptInstallHooks();
      } else if (hooksOutdated()) {
        console.log(chalk.yellow('⚡ Updating hooks…'));
        await installHooks();
      } else {
        console.log(chalk.gray('Claude Code hooks already installed. ✓'));
      }

      // Wire into any newly installed platforms (Codex, Gemini)
      await wireMcpServer();
      return;
    }
  }

  // 2. API key in env (dashboard path: PURMEMO_API_KEY=sk-... npx purmemo-mcp setup)
  if (process.env.PURMEMO_API_KEY) {
    const spinner = ora('Verifying your API key…').start();
    const user = await verifyApiKey(process.env.PURMEMO_API_KEY);
    if (!user) {
      spinner.stop();
      console.log(chalk.red('❌ API key verification failed. Please check your key and try again.'));
      process.exit(1);
    }
    spinner.stop();

    // Save to auth.json so hooks can read it
    await tokenStore.saveToken({
      access_token: process.env.PURMEMO_API_KEY,
      token_type: 'Bearer',
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      user: {
        email: user.email || 'unknown',
        tier:  user.tier  || 'free',
      },
    });

    console.log(chalk.green.bold('🎉 Connected!\n'));
    console.log(chalk.gray(`   Account: ${user.email}`));
    console.log(chalk.gray(`   Plan:    ${user.tier === 'pro' ? '⭐ Pro' : '🆓 Free'}`));
    console.log('');

    // Wire up Claude Code
    wireMcpServer();
    await promptInstallHooks();
    printSuccess();
    return;
  }

  // 3. Browser-open OAuth flow
  console.log(chalk.white('Connecting your pūrmemo account…\n'));

  let sessionId: string;
  let pairingCode: string;
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/cli/request`, { method: 'POST' });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    sessionId = data.session_id;
    pairingCode = data.pairing_code;
  } catch (err) {
    console.error(chalk.red(`\n❌ Could not reach pūrmemo servers: ${err.message}`));
    console.log(chalk.gray('Check your internet connection and try again.'));
    process.exit(1);
  }

  const connectUrl = `${APP_URL}/cli-connect?session=${sessionId}`;
  console.log(chalk.cyan('🌐 Opening your browser…'));
  console.log(chalk.gray(`   ${connectUrl}\n`));
  console.log(chalk.gray('If the browser did not open, copy the URL above and paste it manually.\n'));

  // Display pairing code — user must type this into the browser
  console.log(chalk.bold('Your pairing code:'));
  console.log(chalk.bgWhite.black.bold(`  ${pairingCode}  `));
  console.log(chalk.gray('Enter this code in the browser when asked.\n'));

  try {
    const open = (await import('open')).default;
    await open(connectUrl);
  } catch {}

  const spinner = ora('Waiting for you to sign in…').start();
  const deadline = Date.now() + 10 * 60 * 1000;
  const POLL_MS  = 2500;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let pollData;
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/cli/poll/${sessionId}`);
      if (!res.ok) continue;
      pollData = await res.json();
    } catch { continue; }

    if (pollData.status === 'completed' && pollData.api_key) {
      spinner.stop();

      await tokenStore.saveToken({
        access_token: pollData.api_key,
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        user: {
          email: pollData.email || 'unknown',
          tier:  pollData.tier  || 'free',
        },
      });

      console.log(chalk.green.bold('\n🎉 Connected!\n'));
      console.log(chalk.gray(`   Account: ${pollData.email || 'connected'}`));
      console.log(chalk.gray(`   Plan:    ${pollData.tier === 'pro' ? '⭐ Pro (unlimited)' : '🆓 Free (50 recalls/month)'}`));
      console.log('');

      wireMcpServer();
      await promptInstallHooks();
      printSuccess();
      return;
    }

    if (pollData.status === 'expired') {
      spinner.stop();
      console.log(chalk.yellow('\n⏰ Session expired. Run setup again:'));
      console.log(chalk.cyan('   npx purmemo-mcp setup'));
      process.exit(1);
    }

    const elapsed = Math.floor((Date.now() - (deadline - 10 * 60 * 1000)) / 1000);
    if (elapsed % 15 === 0 && elapsed > 0) {
      spinner.text = `Still waiting… (${elapsed}s) — check your browser`;
    }
  }

  spinner.stop();
  console.log(chalk.yellow('\n⏰ Timed out after 10 minutes. Run setup again when ready:'));
  console.log(chalk.cyan('   npx purmemo-mcp setup'));
  process.exit(1);
}

// ─── Hooks-only command ───────────────────────────────────────────────────────

async function runHooksOnly() {
  console.log(chalk.cyan(banner));
  const token = await tokenStore.getToken();
  if (!token?.access_token && !process.env.PURMEMO_API_KEY) {
    console.log(chalk.yellow('⚠️  Not connected. Run setup first:'));
    console.log(chalk.cyan('   npx purmemo-mcp setup'));
    process.exit(1);
  }
  if (hasOldHooks()) {
    console.log(chalk.yellow('⚡ Upgrading hooks to v2…'));
    await installHooks();
    return;
  }
  if (hooksAlreadyInstalled()) {
    console.log(chalk.green('✅ Claude Code hooks are already installed.'));
    return;
  }
  await installHooks();
}

// ─── Hook installation ────────────────────────────────────────────────────────

function hooksAlreadyInstalled() {
  if (!HOOK_SCRIPTS.every(f => fs.existsSync(path.join(HOOKS_DIR, f)))) return false;
  // Also verify event bindings are correct in settings.json
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return false;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const hooks = settings.hooks || {};
    const has = (arr: unknown[], name: string) =>
      Array.isArray(arr) && arr.some((e: any) => e.hooks?.some((h: any) => h.command?.includes(name)));
    return has(hooks.SessionStart, 'purmemo_recall') &&
           has(hooks.UserPromptSubmit, 'purmemo_first_message');
  } catch { return false; }
}

function hooksOutdated(): boolean {
  try {
    const libPath = path.join(HOOKS_DIR, 'purmemo_lib.js');
    if (!fs.existsSync(libPath)) return false;
    const content = fs.readFileSync(libPath, 'utf8');
    const match = content.match(/HOOKS_VERSION\s*=\s*["']([^"']+)["']/);
    if (!match) return true; // can't determine version → treat as outdated
    const installed = match[1];
    if (installed.startsWith('__')) return true; // unstamped dev version
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
    // Compare semver: if installed < package version, outdated
    const i = installed.split('.').map(Number);
    const p = pkgVersion.split('.').map(Number);
    for (let n = 0; n < 3; n++) {
      if ((i[n] || 0) < (p[n] || 0)) return true;
      if ((i[n] || 0) > (p[n] || 0)) return false;
    }
    return false;
  } catch { return false; }
}

function hasOldHooks() {
  return OLD_HOOK_SCRIPTS.some(f => fs.existsSync(path.join(HOOKS_DIR, f)));
}

function migrateOldHooks() {
  // Remove old hook files from Claude Code install
  for (const file of OLD_HOOK_SCRIPTS) {
    const p = path.join(HOOKS_DIR, file);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  // Remove old hook entries from Claude Code settings.json
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (settings.hooks) {
        const oldNames = ['purmemo_session_start', 'purmemo_save', 'purmemo_heartbeat', 'purmemo_precompact', 'purmemo_capture'];
        for (const eventKey of Object.keys(settings.hooks)) {
          if (Array.isArray(settings.hooks[eventKey])) {
            settings.hooks[eventKey] = settings.hooks[eventKey].filter(
              (entry) => !entry.hooks?.some((h) => oldNames.some(n => h.command?.includes(n)))
            );
            if (settings.hooks[eventKey].length === 0) delete settings.hooks[eventKey];
          }
        }
        const tmp = SETTINGS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
        fs.renameSync(tmp, SETTINGS_FILE);
      }
    }
  } catch {}

  // Retire purmemo_capture from Gemini CLI extension (v15.3.0+)
  // AMP is the canonical capture path; this hook was creating mislabeled cloud memories.
  try {
    const geminiExtHooks = path.join(os.homedir(), '.purmemo', 'gemini-extension', 'hooks', 'hooks.json');
    const geminiExtScripts = path.join(os.homedir(), '.purmemo', 'gemini-extension', 'scripts');
    const geminiCaptureScript = path.join(geminiExtScripts, 'purmemo_capture.js');

    if (fs.existsSync(geminiExtHooks)) {
      const hooksData = JSON.parse(fs.readFileSync(geminiExtHooks, 'utf8'));
      if (hooksData.hooks) {
        for (const eventKey of Object.keys(hooksData.hooks)) {
          if (Array.isArray(hooksData.hooks[eventKey])) {
            hooksData.hooks[eventKey] = hooksData.hooks[eventKey].filter(
              (entry) => !entry.hooks?.some((h) => h.command?.includes('purmemo_capture'))
            );
            if (hooksData.hooks[eventKey].length === 0) delete hooksData.hooks[eventKey];
          }
        }
        const tmp = geminiExtHooks + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(hooksData, null, 2), 'utf8');
        fs.renameSync(tmp, geminiExtHooks);
      }
    }

    if (fs.existsSync(geminiCaptureScript)) fs.unlinkSync(geminiCaptureScript);
  } catch {}
}

async function promptInstallHooks() {
  // Skip prompt if not a TTY (e.g. CI, piped input)
  if (!process.stdin.isTTY) {
    await installHooks();
    return;
  }

  console.log(chalk.white('Install Claude Code hooks + commands?'));
  console.log(chalk.gray('  Hooks (automatic):'));
  console.log(chalk.gray('  • Recall        — shows your 5 most recent memories at startup'));
  console.log(chalk.gray('  • Quick-load    — type a number (1-5) to load a memory fully'));
  console.log(chalk.gray('  For auto-capture, install purmemoAMP: github.com/purmemo-ai/purmemo-amp'));
  console.log(chalk.gray('  Commands (you type):'));
  console.log(chalk.gray('  • /save         — save conversation as a living document'));
  console.log(chalk.gray('  • /recall       — search past memories'));
  console.log(chalk.gray('  • /context      — get full project context'));
  console.log(chalk.gray('  • /purmemo      — run memory-powered workflows (debug, prd, review, etc.)'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question(chalk.cyan('Install hooks? [Y/n]: '));
  } finally {
    rl.close();
  }

  if (answer.trim().toLowerCase() === 'n') {
    console.log(chalk.gray('\nSkipped. Install later with: npx purmemo-mcp hooks'));
    return;
  }

  await installHooks();
}

async function installHooks() {
  const spinner = ora('Installing Claude Code hooks…').start();

  try {
    // 0. Migrate old hooks if present
    if (hasOldHooks()) migrateOldHooks();

    // 1. Ensure ~/.claude/hooks/ exists
    fs.mkdirSync(HOOKS_DIR, { recursive: true });

    // 2. Write ESM package.json (hooks use import/export)
    const hooksPkg = path.join(HOOKS_DIR, 'package.json');
    if (!fs.existsSync(hooksPkg)) {
      fs.writeFileSync(hooksPkg, '{"type":"module"}\n', 'utf8');
    }

    // 3. Copy hook scripts from package to ~/.claude/hooks/
    //    Stamp __HOOKS_VERSION__ in purmemo_lib.js with actual version from package.json
    const srcHooksDir = path.join(__dirname, 'hooks');
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
    for (const file of HOOK_SCRIPTS) {
      const src  = path.join(srcHooksDir, file);
      const dest = path.join(HOOKS_DIR, file);
      if (file === 'purmemo_lib.js') {
        // Stamp version placeholder with actual version
        let content = fs.readFileSync(src, 'utf8');
        content = content.replace(/__HOOKS_VERSION__/g, pkgVersion);
        fs.writeFileSync(dest, content, 'utf8');
      } else {
        fs.copyFileSync(src, dest);
      }
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    }

    // 4. Copy slash commands to ~/.claude/commands/
    fs.mkdirSync(COMMANDS_DIR, { recursive: true });
    const srcCommandsDir = path.join(__dirname, '..', 'src', 'commands');
    // Fallback: commands may be in dist/ for published packages
    const cmdSourceDir = fs.existsSync(srcCommandsDir) ? srcCommandsDir : path.join(__dirname, 'commands');
    if (fs.existsSync(cmdSourceDir)) {
      for (const file of COMMAND_FILES) {
        const src = path.join(cmdSourceDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(COMMANDS_DIR, file));
        }
      }
    }

    // 5. Patch ~/.claude/settings.json
    patchSettings();

    spinner.stop();
    console.log(chalk.green('✅ Claude Code hooks + commands installed!'));
    console.log(chalk.gray(`   Hooks:    ~/.claude/hooks/purmemo_*.js`));
    console.log(chalk.gray(`   Commands: /save, /recall, /context, /purmemo`));
    console.log(chalk.gray(`   Config:   ~/.claude/settings.json`));
  } catch (err) {
    spinner.stop();
    console.log(chalk.yellow(`⚠️  Could not install hooks: ${err.message}`));
    console.log(chalk.gray('   You can install them manually later: npx purmemo-mcp hooks'));
  }
}

function patchSettings() {
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch {}

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  const hookCmd = (file: string) => `node ${path.join(HOOKS_DIR, file)}`;
  const has = (arr: unknown[], name: string) =>
    arr.some((e: any) => e.hooks?.some((h: any) => h.command?.includes(name)));

  // SessionStart → recall
  if (!hooks.SessionStart) hooks.SessionStart = [];
  if (!has(hooks.SessionStart, 'purmemo_recall')) {
    hooks.SessionStart.push({ hooks: [{ type: 'command', command: hookCmd('purmemo_recall.js') }] });
  }

  // UserPromptSubmit → first_message (number quick-load)
  if (!hooks.UserPromptSubmit) hooks.UserPromptSubmit = [];
  if (!has(hooks.UserPromptSubmit, 'purmemo_first_message')) {
    hooks.UserPromptSubmit.push({
      matcher: '.*',
      hooks: [{ type: 'command', command: hookCmd('purmemo_first_message.js') }],
    });
  }

  // Note: PostToolUse / PreCompact / Stop capture hooks were removed in v15.3.0.
  // purmemoAMP is the canonical capture path — it watches session JSONL files
  // directly via SessionStore + SessionMemoryExtractor and handles cloud sync.
  // Users who want AMP capture: install purmemoAMP.app from github.com/purmemo-ai/purmemo-amp.

  // Write atomically
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

// ─── Wire MCP server into Claude Code ─────────────────────────────────────────

async function wireMcpServer() {
  // Get API key for platform configs
  let apiKey = process.env.PURMEMO_API_KEY || '';
  if (!apiKey) {
    const token = await tokenStore.getToken();
    apiKey = token?.access_token || '';
  }

  // Claude Code — include PURMEMO_API_KEY so the MCP process has auth at startup
  try {
    // Remove existing entry first (idempotent re-registration with fresh key)
    execSync('claude mcp remove purmemo', { stdio: 'ignore', timeout: 5000 });
  } catch { /* not registered yet — that's fine */ }
  try {
    const envFlag = apiKey ? `-e PURMEMO_API_KEY=${apiKey} ` : '';
    execSync(`claude mcp add purmemo ${envFlag}-- npx -y purmemo-mcp@latest`, {
      stdio: 'ignore',
      timeout: 10000,
    });
    console.log(chalk.green('✅ MCP server registered with Claude Code'));
  } catch {
    console.log(chalk.gray('To add the MCP server manually, run:'));
    console.log(chalk.cyan(`   claude mcp add purmemo${apiKey ? ` -e PURMEMO_API_KEY=${apiKey}` : ''} -- npx -y purmemo-mcp@latest`));
    console.log('');
  }

  // Codex (OpenAI)
  wireCodex(apiKey);
  installCodexSkill();

  // Gemini CLI (Google)
  wireGemini(apiKey);
  installGeminiExtension();
}

// ─── Wire MCP server into OpenAI Codex ────────────────────────────────────────

function wireCodex(apiKey: string) {
  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(codexConfig)) return;

  try {
    let content = fs.readFileSync(codexConfig, 'utf8');
    if (content.includes('purmemo')) {
      console.log(chalk.green('✅ MCP server already registered with Codex'));
      return;
    }

    const purmemoLine = apiKey
      ? `purmemo = { command = "npx", args = ["-y", "purmemo-mcp@latest"], env = { PURMEMO_API_KEY = "${apiKey}", MCP_PLATFORM = "codex" } }`
      : `purmemo = { command = "npx", args = ["-y", "purmemo-mcp@latest"], env = { MCP_PLATFORM = "codex" } }`;

    if (content.includes('[mcp_servers]')) {
      content = content.replace(/(\[mcp_servers\]\n)/, `$1${purmemoLine}\n`);
    } else {
      content = content.trimEnd() + `\n\n[mcp_servers]\n${purmemoLine}\n`;
    }

    const tmp = codexConfig + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, codexConfig);
    console.log(chalk.green('✅ MCP server registered with Codex'));
  } catch (err) {
    console.log(chalk.gray(`Could not configure Codex: ${(err as Error).message}`));
  }
}

// ─── Wire MCP server into Gemini CLI ──────────────────────────────────────────

function wireGemini(apiKey: string) {
  const geminiConfig = path.join(os.homedir(), '.gemini', 'settings.json');
  if (!fs.existsSync(geminiConfig)) return;

  try {
    const settings = JSON.parse(fs.readFileSync(geminiConfig, 'utf8'));
    if (!settings.mcpServers) settings.mcpServers = {};

    if (settings.mcpServers.purmemo) {
      console.log(chalk.green('✅ MCP server already registered with Gemini CLI'));
      return;
    }

    settings.mcpServers.purmemo = {
      command: 'npx',
      args: ['-y', 'purmemo-mcp@latest'],
      env: {
        ...(apiKey ? { PURMEMO_API_KEY: apiKey } : {}),
        MCP_PLATFORM: 'gemini',
      },
    };

    const tmp = geminiConfig + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, geminiConfig);
    console.log(chalk.green('✅ MCP server registered with Gemini CLI'));
  } catch (err) {
    console.log(chalk.gray(`Could not configure Gemini CLI: ${(err as Error).message}`));
  }
}

// ─── Install Gemini CLI Extension (hooks + commands) ──────────────────────────

function installGeminiExtension() {
  const geminiDir = path.join(os.homedir(), '.gemini');
  if (!fs.existsSync(geminiDir)) return;

  try {
    const extDir = path.join(os.homedir(), '.purmemo', 'gemini-extension');
    const scriptsDir = path.join(extDir, 'scripts');
    const commandsDir = path.join(extDir, 'commands');
    const hooksDir = path.join(extDir, 'hooks');

    // Create extension directory structure
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });

    // Write ESM package.json for hooks
    const pkgJson = path.join(scriptsDir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      fs.writeFileSync(pkgJson, '{"type":"module"}\n', 'utf8');
    }

    // Source directories (from npm package dist/)
    const srcHooksDir = path.join(__dirname, 'hooks');
    const srcGeminiDir = path.join(__dirname, '..', 'src', 'gemini');
    // Fallback: in published packages, gemini assets may be in dist/
    const geminiAssetsDir = fs.existsSync(srcGeminiDir) ? srcGeminiDir : path.join(__dirname, 'gemini');

    // Copy hook scripts to extension/scripts/
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
    for (const file of HOOK_SCRIPTS) {
      const src = path.join(srcHooksDir, file);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(scriptsDir, file);
      if (file === 'purmemo_lib.js') {
        let content = fs.readFileSync(src, 'utf8');
        content = content.replace(/__HOOKS_VERSION__/g, pkgVersion);
        fs.writeFileSync(dest, content, 'utf8');
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    // Copy gemini-extension.json
    const manifestSrc = path.join(geminiAssetsDir, 'gemini-extension.json');
    if (fs.existsSync(manifestSrc)) {
      fs.copyFileSync(manifestSrc, path.join(extDir, 'gemini-extension.json'));
    }

    // Copy hooks.json
    const hooksSrc = path.join(geminiAssetsDir, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksSrc)) {
      fs.copyFileSync(hooksSrc, path.join(hooksDir, 'hooks.json'));
    }

    // Copy TOML commands
    const cmdsSrc = path.join(geminiAssetsDir, 'commands');
    if (fs.existsSync(cmdsSrc)) {
      for (const file of fs.readdirSync(cmdsSrc)) {
        if (file.endsWith('.toml')) {
          fs.copyFileSync(path.join(cmdsSrc, file), path.join(commandsDir, file));
        }
      }
    }

    // Try to link the extension with Gemini CLI
    try {
      // Check if already installed
      const extList = execSync('gemini extensions list 2>&1', { encoding: 'utf8', timeout: 10000 });
      if (extList.includes('purmemo')) {
        console.log(chalk.green('✅ Gemini CLI extension already installed (hooks + commands)'));
      } else {
        // Pipe Y to auto-approve the hooks security warning
        execSync(`echo Y | gemini extensions link "${extDir}"`, {
          stdio: 'pipe',
          timeout: 15000,
        });
        console.log(chalk.green('✅ Gemini CLI extension installed (hooks + commands)'));
      }
    } catch {
      console.log(chalk.green('✅ Gemini CLI extension prepared at ~/.purmemo/gemini-extension/'));
      console.log(chalk.gray('   To activate: gemini extensions link ~/.purmemo/gemini-extension/'));
    }
  } catch (err) {
    console.log(chalk.gray(`Could not install Gemini extension: ${(err as Error).message}`));
  }
}

// ─── Install Codex Skill ──────────────────────────────────────────────────────

function installCodexSkill() {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexDir)) return;

  try {
    const skillDir = path.join(codexDir, 'skills', 'purmemo');
    fs.mkdirSync(skillDir, { recursive: true });

    // Source: from npm package
    const srcSkill = path.join(__dirname, '..', 'src', 'codex', 'SKILL.md');
    const distSkill = path.join(__dirname, 'codex', 'SKILL.md');
    const skillSrc = fs.existsSync(srcSkill) ? srcSkill : distSkill;

    if (fs.existsSync(skillSrc)) {
      fs.copyFileSync(skillSrc, path.join(skillDir, 'SKILL.md'));
      console.log(chalk.green('✅ Codex skill installed'));
    }
  } catch (err) {
    console.log(chalk.gray(`Could not install Codex skill: ${(err as Error).message}`));
  }
}

function printSuccess() {
  console.log('');
  console.log(chalk.white('Your AI tools now have persistent memory across sessions.'));
  console.log('');
  console.log(chalk.gray('  Save a conversation: ') + chalk.white('"Save this conversation"'));
  console.log(chalk.gray('  Recall later:        ') + chalk.white('"What did we discuss about X?"'));
  console.log('');
  console.log(chalk.gray('Open a new session in Claude Code, Codex, or Gemini to activate.'));
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function runStatus() {
  console.log(chalk.cyan(banner));

  if (process.env.PURMEMO_API_KEY) {
    console.log(chalk.green('✅ Connected via PURMEMO_API_KEY environment variable'));
    await testApiKey(process.env.PURMEMO_API_KEY);
  } else {
    const token = await tokenStore.getToken();
    if (!token?.access_token) {
      console.log(chalk.yellow('⚠️  Not connected'));
      console.log(chalk.gray('\nRun setup to connect:'));
      console.log(chalk.cyan('   npx purmemo-mcp setup'));
      return;
    }
    console.log(chalk.green('✅ Connected via ~/.purmemo/auth.json'));
    await testApiKey(token.access_token);
  }

  console.log('');
  if (hooksAlreadyInstalled()) {
    console.log(chalk.green('✅ Claude Code hooks installed'));
  } else {
    console.log(chalk.yellow('⚠️  Claude Code hooks not installed'));
    console.log(chalk.gray('   Run: npx purmemo-mcp hooks'));
  }
}

async function testApiKey(apiKey) {
  const spinner = ora('Testing connection…').start();
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    spinner.stop();
    if (res.ok) {
      const user = await res.json();
      console.log(chalk.gray(`   Account: ${user.email}`));
      console.log(chalk.gray(`   Tier:    ${user.tier || 'free'}`));
    } else {
      console.log(chalk.red(`   API returned ${res.status} — key may be invalid`));
      console.log(chalk.gray('   Run: npx purmemo-mcp setup'));
    }
  } catch (err) {
    spinner.stop();
    console.log(chalk.red(`   Connection failed: ${err.message}`));
  }
}

async function verifyApiKey(apiKey) {
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── Logout ───────────────────────────────────────────────────────────────────

async function runLogout() {
  console.log(chalk.cyan(banner));
  const hasToken = await tokenStore.hasToken();
  if (!hasToken) {
    console.log(chalk.gray('Not connected via local token. Nothing to clear.'));
    return;
  }
  await tokenStore.clearToken();
  console.log(chalk.green('✅ Disconnected. Local token cleared.'));
  console.log(chalk.gray('Run setup again to reconnect: npx purmemo-mcp setup'));
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
