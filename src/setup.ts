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
import {
  getActiveTokenFile,
  getActiveProfileLabel,
  getConfigDir,
  getProfilesDir,
  getLegacyTokenFile,
  profileFile,
  listProfiles,
  readActivePointer,
  writeActivePointer,
  clearActivePointer,
} from './auth/profile-resolver.js';
import { migrateLegacyAuthIfNeeded } from './auth/profile-migrator.js';
import { shouldUseEnvVarAuth } from './auth/setup-decisions.js';
import { detectInstallMethod, type InstallMethod } from './auth/install-detection.js';
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

// Migrate legacy auth.json → profiles/<email>.json before any command runs.
// Idempotent: no-op once migrated, no-op on fresh installs.
await migrateLegacyAuthIfNeeded();

// One-time shell-config scrub. The reconciliation pass in `--update` only
// helps users who *upgrade* to v15.7.5+; users who upgraded straight from
// v15.7.4 → v15.7.5 ran the v15.7.4 update code which knew nothing about
// reconciliation. This catch-up runs once on the first CLI invocation of
// v15.7.6+, then writes a sentinel file so subsequent runs no-op.
//
// Silent unless something was actually scrubbed — keeps `purmemo`,
// `purmemo status`, etc. visually unchanged for users with clean shells.
await runOneTimeShellScrubIfNeeded();

switch (command) {
  case 'setup':
  case 'init':     await runSetup();  break;
  case 'status':   await runStatus(); break;
  case 'where':    runWhere(); break;
  case 'uninstall':await runUninstall(process.argv.includes('--yes')); break;
  case 'logout':   await runLogout(); break;
  case 'hooks':    await runHooksOnly(); break;
  case 'accounts': await runAccounts(); break;
  case 'use':      await runUse(process.argv[3]); break;
  case 'add':      await runSetup(/*forceNewProfile=*/true); break;
  case 'remove':   await runRemove(process.argv[3], process.argv.includes('--force')); break;
  case 'update':
  case '--update': await runUpdate(); break;
  case 'help':
  case '--help':
  case '-h':       runHelp(); break;
  default:
    console.log(chalk.red(`Unknown command: ${command}`));
    runHelp();
    process.exit(1);
}

function runHelp() {
  console.log(chalk.cyan(banner));
  console.log(chalk.bold('Usage:'));
  console.log('  purmemo <command>          (or: npx purmemo-mcp <command>)\n');
  console.log(chalk.bold('Commands:'));
  console.log('  init               Connect an account and install hooks (default)');
  console.log('  status             Show the active account and connection health');
  console.log('  where              Show where your config lives (paths + active source)');
  console.log('  accounts           List all connected accounts');
  console.log('  add                Connect another account (keeps existing accounts)');
  console.log('  use <email>        Switch the active account');
  console.log('  remove <email>     Remove a connected account');
  console.log('  logout             Disconnect the active account');
  console.log('  hooks              Reinstall hooks only');
  console.log('  update             Self-upgrade to the latest published version');
  console.log('  uninstall          Show how to fully remove purmemo from this machine');
  console.log('  help               Show this message');
  console.log('');
  console.log(chalk.bold('Environment:'));
  console.log('  PURMEMO_PROFILE=<email>   Override active account for this shell only');
}

// ─── Update ───────────────────────────────────────────────────────────────────
//
// `purmemo --update` does the right thing per install method:
//   - Global (npm i -g)  → re-runs `npm i -g purmemo-mcp@latest` in place.
//   - npx               → clears ~/.npm/_npx so next invocation re-resolves.
//   - Local (project)   → tells the user to bump it in their package.json.
//   - Unknown           → prints manual instructions.
//
// The pre-v15.7 version only cleared the npx cache and printed "next run will
// fetch X" — confusing for users who installed globally because their `purmemo`
// bin stayed on the old version.

async function runUpdate() {
  console.log(chalk.cyan(banner));

  const installedVersion = readInstalledVersion();
  const latest = await fetchLatestVersion();
  const installMethod = detectCurrentInstallMethod();

  console.log(chalk.bold('Versions:'));
  console.log(chalk.gray(`   Installed: v${installedVersion}`));
  console.log(chalk.gray(`   Latest:    ${latest ? 'v' + latest : 'could not fetch'}`));
  console.log(chalk.gray(`   Install:   ${installMethod}`));
  console.log('');

  // Step 1: bring the package itself up to latest if needed.
  let upgradeAttempted = false;
  if (!latest) {
    console.log(chalk.yellow('Could not check npm registry — keeping current version.'));
  } else if (latest === installedVersion) {
    console.log(chalk.gray('Package is already current.'));
  } else {
    upgradeAttempted = true;
    if (installMethod === 'global') {
      console.log(chalk.cyan(`Upgrading global install to v${latest}…`));
      const spinner = ora('Running: npm i -g purmemo-mcp@latest').start();
      try {
        execSync('npm i -g purmemo-mcp@latest', { stdio: 'pipe' });
        spinner.stop();
        console.log(chalk.green(`✅ Upgraded to v${latest}`));
      } catch (err) {
        spinner.stop();
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message;
        console.log(chalk.red('❌ Upgrade failed.'));
        if (stderr.includes('EACCES') || stderr.includes('permission')) {
          console.log(chalk.gray('   This usually means npm needs sudo on your system.'));
          console.log(chalk.cyan('   Try: sudo npm i -g purmemo-mcp@latest'));
        } else {
          console.log(chalk.gray(`   ${stderr.split('\n')[0]}`));
          console.log(chalk.cyan('   Try manually: npm i -g purmemo-mcp@latest'));
        }
        // Don't return — still run the reconciliation pass on the old binary.
      }
    } else if (installMethod === 'npx') {
      const npxCache = path.join(os.homedir(), '.npm', '_npx');
      if (fs.existsSync(npxCache)) {
        try {
          fs.rmSync(npxCache, { recursive: true, force: true });
          console.log(chalk.green(`✅ npx cache cleared — next run fetches v${latest}.`));
        } catch (err) {
          console.log(chalk.yellow(`⚠️  Could not clear npx cache: ${(err as Error).message}`));
          console.log(chalk.gray(`   You can clear it manually: rm -rf ${npxCache}`));
        }
      } else {
        console.log(chalk.gray(`No npx cache to clear. Next run fetches v${latest}.`));
      }
    } else if (installMethod === 'local') {
      console.log(chalk.cyan('This is a local project install.'));
      console.log(chalk.gray(`   Bump purmemo-mcp to ^${latest} in your package.json, then:`));
      console.log(chalk.cyan('   npm install'));
    } else {
      console.log(chalk.cyan(`v${latest} is available. Update manually:`));
      console.log(chalk.gray('   • Global: ') + chalk.cyan('npm i -g purmemo-mcp@latest'));
    }
  }

  // Step 2: reconcile the rest of the installation regardless of whether we
  // upgraded the package. A user on the latest version may still have stale
  // hooks, a legacy auth.json, or a `PURMEMO_API_KEY=` line in their shell
  // config. `--update` should bring everything to the current shape.
  console.log('');
  await reconcileInstallation();
}

// Bring the local installation in line with what the current package version
// expects. Idempotent — every step is a no-op when there's nothing to do.
//
// Three steps, all silent unless they actually do something:
//   1. Migrate legacy ~/.purmemo/auth.json → profiles/<email>.json
//   2. Refresh Claude Code hooks if their stamped version is below the
//      installed package version (or unstamped/dev)
//   3. Comment out `export PURMEMO_API_KEY=...` lines in shell rc files
async function reconcileInstallation(): Promise<void> {
  const summary: string[] = [];

  // --- 1. Migrate legacy auth.json --------------------------------------------
  try {
    const result = await migrateLegacyAuthIfNeeded();
    if (result.status === 'migrated' && result.email) {
      summary.push(`Migrated legacy auth.json → profile for ${result.email}`);
    }
  } catch { /* migrator handles its own errors; nothing to add */ }

  // --- 2. Refresh hooks if outdated -------------------------------------------
  // Only attempt if hooks are already installed (we don't want `--update` to
  // install hooks for the first time on a brand-new machine — that's `init`'s
  // job). And only if their stamped HOOKS_VERSION is below this package's.
  try {
    if (HOOK_SCRIPTS.every(f => fs.existsSync(path.join(HOOKS_DIR, f))) && hooksOutdated()) {
      await installHooks();
      summary.push('Refreshed Claude Code hooks');
    }
  } catch { /* non-fatal — show nothing rather than partial state */ }

  // --- 3. Scrub PURMEMO_API_KEY from shell configs ----------------------------
  try {
    const edits = scrubShellConfigKey();
    if (edits.length > 0) {
      const detail = edits.map(e => `${e.file}:${e.line}`).join(', ');
      summary.push(`Cleaned up legacy PURMEMO_API_KEY: ${detail} (commented out, revertible)`);
    }
  } catch { /* non-fatal */ }

  // --- Output -----------------------------------------------------------------
  if (summary.length === 0) {
    console.log(chalk.green('✅ You\'re all set.'));
  } else {
    console.log(chalk.bold('Cleaned up:'));
    for (const item of summary) {
      console.log(chalk.gray(`   • ${item}`));
    }
    console.log('');
    console.log(chalk.green('✅ You\'re all set.'));
  }
}

function readInstalledVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch { return 'unknown'; }
}

async function fetchLatestVersion(): Promise<string | null> {
  const spinner = ora('Checking npm registry…').start();
  try {
    const res = await fetch('https://registry.npmjs.org/purmemo-mcp/latest');
    spinner.stop();
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version || null;
  } catch {
    spinner.stop();
    return null;
  }
}

function detectCurrentInstallMethod(): InstallMethod {
  // packageDir = directory containing this package's package.json (one level
  // above dist/setup.js → ../).
  const packageDir = path.resolve(__dirname, '..');
  let globalRoot: string | null = null;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* npm not on PATH or slow — fall back to non-global */ }
  return detectInstallMethod(packageDir, globalRoot);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function runSetup(forceNewProfile = false) {
  console.log(chalk.cyan(banner));

  // `add` re-runs OAuth into a new profile even if already connected.
  // Skip the "already connected" short-circuit in that case.
  const existing = forceNewProfile ? null : await tokenStore.getToken();
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
      const others = listProfiles().filter(e => e !== info?.email);
      if (others.length > 0) {
        console.log(chalk.gray('Other accounts on this machine: ') + chalk.cyan(others.join(', ')));
        console.log(chalk.gray('Switch with: ') + chalk.cyan('purmemo use <email>'));
      } else {
        console.log(chalk.gray('Add another account: ') + chalk.cyan('purmemo add'));
        console.log(chalk.gray('Disconnect:          ') + chalk.cyan('purmemo logout'));
      }
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
  //
  // `add` MUST skip this branch — the user explicitly asked to connect a new
  // account, and a stale PURMEMO_API_KEY in their shell would hijack the flow
  // and silently re-confirm whichever account that key belongs to. (Same class
  // of bug as ADR-031 / Jode-Leigh cross-account saves, 2026-04-24.)
  // Decision lives in shouldUseEnvVarAuth() so a regression test can lock it.
  if (shouldUseEnvVarAuth({ envApiKey: process.env.PURMEMO_API_KEY, forceNewProfile })) {
    const spinner = ora('Verifying your API key…').start();
    const user = await verifyApiKey(process.env.PURMEMO_API_KEY);
    if (!user) {
      spinner.stop();
      console.log(chalk.red('❌ API key verification failed. Please check your key and try again.'));
      process.exit(1);
    }
    spinner.stop();

    // Loud warning so the user knows the env var (not OAuth) drove this auth.
    // ADR-031 history shows PURMEMO_API_KEY in the shell is a recurring footgun.
    console.log(chalk.yellow('⚠️  Authenticated via PURMEMO_API_KEY environment variable'));
    console.log(chalk.gray(`   Account: ${user.email || 'unknown'}`));
    console.log(chalk.gray(`   If this is not the account you wanted, run:`));
    console.log(chalk.cyan(`   unset PURMEMO_API_KEY && purmemo init`));
    console.log('');

    const envEmail = (user.email || '').trim().toLowerCase();
    const tokenData = {
      access_token: process.env.PURMEMO_API_KEY,
      token_type: 'Bearer',
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      user: {
        email: envEmail || 'unknown',
        tier:  user.tier  || 'free',
      },
    };
    if (envEmail) {
      try {
        const profileStore = new TokenStore(profileFile(envEmail));
        await profileStore.saveToken(tokenData);
        writeActivePointer(envEmail);
      } catch {
        await tokenStore.saveToken(tokenData);
      }
    } else {
      await tokenStore.saveToken(tokenData);
    }
    syncKeyToShellRc(process.env.PURMEMO_API_KEY);

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

      const email = (pollData.email || '').trim().toLowerCase();
      const tokenData = {
        access_token: pollData.api_key,
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        user: {
          email: email || 'unknown',
          tier:  pollData.tier  || 'free',
        },
      };

      // Write into per-profile file when we know the email; mark it active.
      // Falls back to active-pointer-resolved path otherwise (legacy behavior).
      if (email) {
        try {
          const profileStore = new TokenStore(profileFile(email));
          await profileStore.saveToken(tokenData);
          writeActivePointer(email);
        } catch {
          await tokenStore.saveToken(tokenData);
        }
      } else {
        await tokenStore.saveToken(tokenData);
      }
      syncKeyToShellRc(pollData.api_key);

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
  if (!token?.access_token) {
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

// ─── Sync API key to shell rc files so hooks always use the current key ───────

// Retired in v15.7.5: this function used to write `export PURMEMO_API_KEY=...`
// into ~/.zshrc and ~/.bashrc during setup. ADR-031 made the env var a runtime
// no-op, but the export lines stuck around in users' shell configs and kept
// surfacing the "PURMEMO_API_KEY is set" warning forever.
//
// We keep the function name as a no-op so the rest of setup.ts continues to
// compile if any caller is missed during the rollout. The actual cleanup of
// existing entries lives in scrubShellConfigKey() (called from runUpdate).
function syncKeyToShellRc(_apiKey: string) {
  // Intentional no-op. See header comment.
}

// Run scrubShellConfigKey() exactly once across all CLI commands. After it
// runs, write a sentinel file so we never look at shell configs again.
// Silent unless something was actually scrubbed.
//
// The sentinel name encodes the version that introduced this catch-up so
// future cleanups (different env vars, different files) can use new sentinels
// without re-running this one.
async function runOneTimeShellScrubIfNeeded(): Promise<void> {
  const configDir = process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
  const sentinel = path.join(configDir, '.scrubbed-shell-config-v15-7-6');
  if (fs.existsSync(sentinel)) return;

  try {
    const edits = scrubShellConfigKey();
    if (edits.length > 0) {
      const detail = edits.map(e => `${e.file}:${e.line}`).join(', ');
      console.log(chalk.gray(`(cleaned up legacy PURMEMO_API_KEY: ${detail} — commented out, revertible)`));
    }
  } catch { /* non-fatal — never block a CLI command on cleanup */ }

  // Always write the sentinel, even if scrub failed or found nothing — we
  // don't want to keep retrying unnecessary work on every command.
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString(), 'utf8');
  } catch { /* best-effort sentinel — if we can't write, we'll just retry next run */ }
}

// Find any `export PURMEMO_API_KEY=...` lines in the user's shell config files
// and comment them out with a dated marker. Reversible: the user can open the
// file, remove the leading "# Removed by purmemo update YYYY-MM-DD: ", and
// the line is back.
//
// Returns a list of {file, lineNumber, before} for the runUpdate summary.
function scrubShellConfigKey(): Array<{ file: string; line: number }> {
  const rcFiles = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.zprofile'),
    path.join(os.homedir(), '.bash_profile'),
  ];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const marker = `# Removed by purmemo update ${today}: `;
  const edits: Array<{ file: string; line: number }> = [];

  // A line we should comment out: `export PURMEMO_API_KEY=...` — also tolerate
  // leading whitespace and quoted values. Anything already commented or already
  // marked by us is skipped.
  const targetRegex = /^\s*export\s+PURMEMO_API_KEY\s*=/;

  for (const rcFile of rcFiles) {
    if (!fs.existsSync(rcFile)) continue;
    try {
      const content = fs.readFileSync(rcFile, 'utf8');
      const lines = content.split('\n');
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw.startsWith('#')) continue; // already commented (by us or anyone)
        if (!targetRegex.test(raw)) continue;
        lines[i] = `${marker}${raw}`;
        edits.push({ file: rcFile, line: i + 1 });
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(rcFile, lines.join('\n'), 'utf8');
      }
    } catch { /* non-fatal — skip unreadable rc files */ }
  }
  return edits;
}

// ─── Wire MCP server into Claude Code ─────────────────────────────────────────

async function wireMcpServer() {
  // auth.json is the single source of truth — no API key baked into any
  // platform config. The MCP process reads auth.json at startup.
  // This eliminates the env var drift that caused cross-account saves (ADR-031).

  // Claude Code — no -e flag, server reads auth.json at startup
  try {
    execSync('claude mcp remove purmemo', { stdio: 'ignore', timeout: 5000 });
  } catch { /* not registered yet — fine */ }
  try {
    execSync(`claude mcp add purmemo -- npx -y purmemo-mcp@latest`, {
      stdio: 'ignore',
      timeout: 10000,
    });
    console.log(chalk.green('✅ MCP server registered with Claude Code'));
  } catch {
    console.log(chalk.gray('To add the MCP server manually, run:'));
    console.log(chalk.cyan(`   claude mcp add purmemo -- npx -y purmemo-mcp@latest`));
    console.log('');
  }

  // Codex (OpenAI)
  wireCodex();
  installCodexSkill();

  // Gemini CLI (Google)
  wireGemini();
  installGeminiExtension();
}

// ─── Wire MCP server into OpenAI Codex ────────────────────────────────────────

function wireCodex() {
  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(codexConfig)) return;

  try {
    let content = fs.readFileSync(codexConfig, 'utf8');
    if (content.includes('purmemo')) {
      console.log(chalk.green('✅ MCP server already registered with Codex'));
      return;
    }

    const purmemoLine = `purmemo = { command = "npx", args = ["-y", "purmemo-mcp@latest"], env = { MCP_PLATFORM = "codex" } }`;

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

function wireGemini() {
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
  console.log('');
  console.log(chalk.gray('💡 Upgrade later with: ') + chalk.cyan('purmemo --update'));
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function runStatus() {
  console.log(chalk.cyan(banner));

  const token = await tokenStore.getToken();
  if (!token?.access_token) {
    console.log(chalk.yellow('⚠️  Not connected'));
    console.log(chalk.gray('\nRun setup to connect:'));
    console.log(chalk.cyan('   purmemo init'));
    return;
  }
  console.log(chalk.green(`✅ Connected — active profile: ${getActiveProfileLabel()}`));
  console.log(chalk.gray(`   File: ${getActiveTokenFile()}`));
  await testApiKey(token.access_token);

  // Surface the env-var-vs-profile situation. Even though ADR-031 removed
  // PURMEMO_API_KEY from runtime read paths, lots of users still have it set
  // from the old install instructions. If it's set AND a profile exists, the
  // user probably thinks they're switching profiles when they aren't.
  if (process.env.PURMEMO_API_KEY && listProfiles().length > 0) {
    console.log('');
    console.log(chalk.yellow('⚠️  PURMEMO_API_KEY is set in your environment.'));
    console.log(chalk.gray('   This is a legacy override. New code reads from profiles, but other'));
    console.log(chalk.gray('   tools (older hooks, scripts) may still pick up the env var. Clear it:'));
    console.log(chalk.cyan('   unset PURMEMO_API_KEY    ') + chalk.gray('# (or remove it from ~/.zshrc / ~/.bashrc)'));
  }

  if (process.env.PURMEMO_PROFILE) {
    console.log(chalk.gray(`\nPURMEMO_PROFILE=${process.env.PURMEMO_PROFILE} is set in your shell — overrides the active pointer here only.`));
  }

  console.log('');
  if (hooksAlreadyInstalled()) {
    console.log(chalk.green('✅ Claude Code hooks installed'));
  } else {
    console.log(chalk.yellow('⚠️  Claude Code hooks not installed'));
    console.log(chalk.gray('   Run: purmemo hooks'));
  }
}

// ─── Where ────────────────────────────────────────────────────────────────────
//
// Quick "where does my config live" command. Designed to be the first thing
// you reach for when something feels off — answers "is this account I think
// is active actually active, and where is it on disk?"

function runWhere() {
  console.log(chalk.cyan(banner));

  const configDir   = getConfigDir();
  const activeFile  = getActiveTokenFile();
  const legacyFile  = getLegacyTokenFile();
  const activePtr   = readActivePointer();
  const profiles    = listProfiles();

  // Determine where the active token *actually* comes from.
  let source: string;
  if (process.env.PURMEMO_PROFILE) {
    source = `env: PURMEMO_PROFILE=${process.env.PURMEMO_PROFILE}`;
  } else if (activePtr && fs.existsSync(profileFile(activePtr))) {
    source = `profile pointer (${activePtr})`;
  } else if (fs.existsSync(legacyFile)) {
    source = 'legacy auth.json (pre-v15.6)';
  } else {
    source = 'nothing connected';
  }

  console.log(chalk.bold('Active source:'));
  console.log(`  ${chalk.cyan(source)}`);
  console.log(`  ${chalk.gray('→')} ${activeFile}`);

  console.log('');
  console.log(chalk.bold('On disk:'));
  console.log(`  ${chalk.gray('config dir:')}  ${configDir}`);
  console.log(`  ${chalk.gray('profiles:')}    ${profiles.length === 0 ? chalk.gray('(none)') : profiles.join(', ')}`);
  console.log(`  ${chalk.gray('active ptr:')}  ${activePtr || chalk.gray('(unset)')}`);
  console.log(`  ${chalk.gray('legacy:')}      ${fs.existsSync(legacyFile) ? legacyFile : chalk.gray('(none)')}`);

  // Env-var transparency — these are the levers that change behavior.
  const envFlags: [string, string | undefined][] = [
    ['PURMEMO_API_KEY',  process.env.PURMEMO_API_KEY ? '(set — see warning below)' : undefined],
    ['PURMEMO_PROFILE',  process.env.PURMEMO_PROFILE],
    ['PURMEMO_API_URL',  process.env.PURMEMO_API_URL],
    ['PURMEMO_REMOTE',   process.env.PURMEMO_REMOTE],
    ['PURMEMO_ADMIN',    process.env.PURMEMO_ADMIN],
    ['MCP_PLATFORM',     process.env.MCP_PLATFORM],
  ];
  const setFlags = envFlags.filter(([, v]) => v !== undefined);
  if (setFlags.length > 0) {
    console.log('');
    console.log(chalk.bold('Environment overrides:'));
    for (const [k, v] of setFlags) {
      console.log(`  ${chalk.gray(k.padEnd(18))}${v}`);
    }
  }

  if (process.env.PURMEMO_API_KEY && profiles.length > 0) {
    console.log('');
    console.log(chalk.yellow('⚠️  PURMEMO_API_KEY is set, but you also have profiles.'));
    console.log(chalk.gray('   The MCP server reads from profiles. Older tools and shell scripts'));
    console.log(chalk.gray('   may still read the env var. Unset it to use the profile system cleanly:'));
    console.log(chalk.cyan('   unset PURMEMO_API_KEY'));
  }
}

// ─── Uninstall ────────────────────────────────────────────────────────────────
//
// We can't safely uninstall the npm package from inside a process the npm
// package owns — the user would be deleting the program currently running.
// Instead: print exact teardown commands, and offer to clear the local config
// (~/.purmemo) interactively.

async function runUninstall(autoYes: boolean) {
  console.log(chalk.cyan(banner));

  const installMethod = detectCurrentInstallMethod();
  const configDir = getConfigDir();
  const configExists = fs.existsSync(configDir);

  console.log(chalk.bold('To fully remove purmemo from this machine:\n'));

  console.log(chalk.gray('1. Disconnect Claude clients (optional — leaves them with a dead server):'));
  console.log(chalk.cyan('   claude mcp remove purmemo') + chalk.gray('   # if you used Claude Code CLI'));
  console.log(chalk.gray('   For Claude Desktop / Cursor / Windsurf: open Settings and remove the purmemo entry.\n'));

  console.log(chalk.gray('2. Uninstall the CLI:'));
  switch (installMethod) {
    case 'global':
      console.log(chalk.cyan('   npm uninstall -g purmemo-mcp'));
      break;
    case 'npx':
      console.log(chalk.cyan('   rm -rf ~/.npm/_npx') + chalk.gray('   # purges the npx cache'));
      break;
    case 'local':
      console.log(chalk.cyan('   npm uninstall purmemo-mcp') + chalk.gray('   # in your project dir'));
      break;
    default:
      console.log(chalk.gray('   Could not detect install method. If installed globally:'));
      console.log(chalk.cyan('   npm uninstall -g purmemo-mcp'));
  }
  console.log('');

  console.log(chalk.gray('3. Remove Claude Code hooks (if installed):'));
  console.log(chalk.cyan(`   rm -f ${HOOK_SCRIPTS.map(f => path.join(HOOKS_DIR, f)).join(' \\\n         ')}`));
  console.log(chalk.cyan(`   rm -f ${COMMAND_FILES.map(f => path.join(COMMANDS_DIR, f)).join(' \\\n         ')}`));
  console.log(chalk.gray('   (You\'ll also want to remove the SessionStart and UserPromptSubmit'));
  console.log(chalk.gray(`    bindings from ${SETTINGS_FILE} manually.)\n`));

  if (configExists) {
    console.log(chalk.bold('4. Local config:'));
    console.log(chalk.gray(`   ${configDir} holds your encrypted profile tokens.`));
    let shouldClear = autoYes;
    if (!autoYes && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question(chalk.cyan('   Clear it now? [y/N] '));
      rl.close();
      shouldClear = ans.trim().toLowerCase() === 'y';
    }
    if (shouldClear) {
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
        console.log(chalk.green(`   ✅ Removed ${configDir}`));
      } catch (err: any) {
        console.log(chalk.red(`   Failed to remove: ${err.message}`));
        console.log(chalk.gray(`   Remove manually: rm -rf ${configDir}`));
      }
    } else {
      console.log(chalk.gray(`   To remove later: ${chalk.cyan('rm -rf ' + configDir)}`));
    }
  } else {
    console.log(chalk.bold('4. Local config:'));
    console.log(chalk.gray(`   No config at ${configDir} — already clean.`));
  }

  if (process.env.PURMEMO_API_KEY) {
    console.log('');
    console.log(chalk.bold('5. Environment:'));
    console.log(chalk.gray('   PURMEMO_API_KEY is set in your environment. Remove it from'));
    console.log(chalk.gray('   ~/.zshrc or ~/.bashrc, then run:'));
    console.log(chalk.cyan('   unset PURMEMO_API_KEY'));
  }

  console.log('');
  console.log(chalk.gray('Done. Thanks for trying purmemo.'));
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
  const info = await tokenStore.getUserInfo();
  const activeFile = getActiveTokenFile();

  const hasToken = await tokenStore.hasToken();
  if (!hasToken) {
    console.log(chalk.gray('Not connected. Nothing to clear.'));
    return;
  }
  await tokenStore.clearToken();

  // If the active profile was a profile file (not legacy auth.json), also
  // clear the active pointer so future commands fall back cleanly.
  const activePtr = readActivePointer();
  if (activePtr && activeFile.endsWith(`${activePtr}.json`)) {
    clearActivePointer();
  }

  // Also remove the legacy auth.json if it holds the same account we just
  // logged out — otherwise the migrator re-creates the profile on next run
  // and "logout" appears to do nothing.
  try {
    const legacyPath = path.join(os.homedir(), '.purmemo', 'auth.json');
    const legacyDir = process.env.PURMEMO_CONFIG_DIR || path.dirname(legacyPath);
    const legacy = path.join(legacyDir, 'auth.json');
    if (fs.existsSync(legacy)) {
      const legacyStore = new TokenStore(legacy);
      const legacyToken = await legacyStore.getToken();
      const legacyEmail = legacyToken?.user?.email?.trim().toLowerCase();
      const loggedOutEmail = info?.email?.trim().toLowerCase();
      if (legacyEmail && loggedOutEmail && legacyEmail === loggedOutEmail) {
        fs.unlinkSync(legacy);
      }
    }
  } catch { /* non-fatal — leaves legacy file alone */ }

  const who = info?.email ? chalk.cyan(info.email) : chalk.gray('active account');
  console.log(chalk.green(`✅ Disconnected ${who}.`));

  const remaining = listProfiles();
  if (remaining.length > 0) {
    console.log(chalk.gray('\nOther accounts on this machine:'));
    remaining.forEach(e => console.log(chalk.gray(`  • ${e}`)));
    console.log(chalk.gray(`\nSwitch to one with: `) + chalk.cyan(`purmemo use <email>`));
  } else {
    console.log(chalk.gray('Run setup again to reconnect: ') + chalk.cyan('purmemo init'));
  }
}

// ─── Accounts / Use / Remove ──────────────────────────────────────────────────

async function runAccounts() {
  console.log(chalk.cyan(banner));
  const profiles = listProfiles();
  const activeLabel = getActiveProfileLabel();

  if (profiles.length === 0) {
    console.log(chalk.yellow('No accounts connected.'));
    console.log(chalk.gray('Connect one with: ') + chalk.cyan('purmemo init'));
    return;
  }

  console.log(chalk.bold('Connected accounts:'));
  for (const email of profiles) {
    const isActive = activeLabel === email || activeLabel === `${email} (env)`;
    const marker   = isActive ? chalk.green('●') : chalk.gray('○');
    const tag      = isActive ? chalk.green(' [active]') : '';
    console.log(`  ${marker} ${email}${tag}`);
  }

  if (process.env.PURMEMO_PROFILE) {
    console.log(chalk.gray(`\nPURMEMO_PROFILE override active for this shell: ${process.env.PURMEMO_PROFILE}`));
  }
  console.log(chalk.gray('\nSwitch with: ') + chalk.cyan('purmemo use <email>'));
  console.log(chalk.gray('Add another: ') + chalk.cyan('purmemo add'));
}

async function runUse(emailArg) {
  console.log(chalk.cyan(banner));
  const email = (emailArg || '').trim().toLowerCase();
  if (!email) {
    console.log(chalk.red('Usage: purmemo use <email>'));
    console.log(chalk.gray('Run `purmemo accounts` to see connected accounts.'));
    process.exit(1);
  }

  const profiles = listProfiles();
  if (!profiles.includes(email)) {
    console.log(chalk.red(`No connected account for ${email}.`));
    if (profiles.length > 0) {
      console.log(chalk.gray('\nConnected accounts:'));
      profiles.forEach(e => console.log(chalk.gray(`  • ${e}`)));
    }
    console.log(chalk.gray('\nConnect a new one with: ') + chalk.cyan('purmemo add'));
    process.exit(1);
  }

  writeActivePointer(email);
  console.log(chalk.green(`✅ Switched to ${email}`));
  console.log(chalk.gray(
    '\nNote: New IDE sessions will use this account. Existing MCP server\n' +
    'processes (already-running Claude Code / Codex / Gemini sessions) keep\n' +
    'their original account until restart.'
  ));
}

async function runRemove(emailArg, force) {
  console.log(chalk.cyan(banner));
  const email = (emailArg || '').trim().toLowerCase();
  if (!email) {
    console.log(chalk.red('Usage: purmemo remove <email> [--force]'));
    process.exit(1);
  }

  const profiles = listProfiles();
  if (!profiles.includes(email)) {
    console.log(chalk.yellow(`No connected account for ${email}. Nothing to remove.`));
    return;
  }

  const activePtr = readActivePointer();
  if (activePtr === email && !force) {
    console.log(chalk.red(`Refusing to remove the active account (${email}).`));
    console.log(chalk.gray('Switch first: ') + chalk.cyan('purmemo use <other-email>'));
    console.log(chalk.gray('Or pass --force to remove the active account anyway.'));
    process.exit(1);
  }

  fs.unlinkSync(profileFile(email));
  if (activePtr === email) clearActivePointer();
  console.log(chalk.green(`✅ Removed ${email}`));
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
