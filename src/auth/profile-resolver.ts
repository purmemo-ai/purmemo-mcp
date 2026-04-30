/**
 * ProfileResolver — single chokepoint for resolving the active auth token file.
 *
 * Storage layout (v15.6+):
 *   ~/.purmemo/
 *     active                          plaintext file: email of active profile
 *     profiles/<email>.json           AES-encrypted token per account
 *     auth.json                       legacy file (pre-v15.6); kept for compat
 *
 * Resolution order:
 *   1. process.env.PURMEMO_PROFILE  → profiles/<email>.json (per-shell override)
 *   2. ~/.purmemo/active pointer    → profiles/<email>.json
 *   3. ~/.purmemo/auth.json         legacy fallback
 *
 * Every read path (TokenStore, hooks/purmemo_lib loadApiKey, server startup)
 * resolves through here. Hooks duplicate the resolution logic inline because
 * they ship as standalone .js files (see hooks/purmemo_lib.ts header), but
 * the rule must stay identical. tests/profile-resolver-contract.test.js
 * locks the two paths together.
 *
 * ADR-031 invariant preserved: no PURMEMO_API_KEY env reads — only file-based
 * tokens. PURMEMO_PROFILE selects WHICH file, never carries a secret.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Resolve config dir on each call so test sandboxes can override it via
// PURMEMO_CONFIG_DIR. In production, falls back to ~/.purmemo.
// (os.homedir() ignores HOME on macOS, so the env override is the cleanest
// way to redirect for tests without monkey-patching ESM imports.)
function configDir() {
  return process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
}
function profilesDir() { return path.join(configDir(), 'profiles'); }
function activePointer() { return path.join(configDir(), 'active'); }
function legacyTokenFile() { return path.join(configDir(), 'auth.json'); }

/** Reject anything that isn't a plausible email-shaped profile name. */
function isSafeProfileName(name: string): boolean {
  if (!name || name.length > 254) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name);
}

export function profileFile(email: string): string {
  if (!isSafeProfileName(email)) {
    throw new Error(`Invalid profile name: ${email}`);
  }
  return path.join(profilesDir(), `${email}.json`);
}

/** Read the active-pointer file. Returns null if missing or unreadable. */
export function readActivePointer(): string | null {
  try {
    const raw = fs.readFileSync(activePointer(), 'utf8').trim();
    return raw && isSafeProfileName(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Write the active-pointer file. Idempotent. */
export function writeActivePointer(email: string): void {
  if (!isSafeProfileName(email)) {
    throw new Error(`Invalid profile name: ${email}`);
  }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(activePointer(), email, 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(activePointer(), 0o600); } catch {}
  }
}

/** Clear the active-pointer file (used on remove of the active profile). */
export function clearActivePointer(): void {
  try { fs.unlinkSync(activePointer()); } catch {}
}

/**
 * List all profile emails on disk. Sorted alphabetically.
 * Does NOT include the legacy auth.json — that's surfaced separately.
 */
export function listProfiles(): string[] {
  try {
    return fs.readdirSync(profilesDir())
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length))
      .filter(isSafeProfileName)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the absolute path to the currently active auth token file.
 * Returns the legacy path even when no profile is configured — the caller
 * gets a path that may or may not exist; existence is its problem.
 */
export function getActiveTokenFile(): string {
  const envProfile = process.env.PURMEMO_PROFILE?.trim();
  if (envProfile && isSafeProfileName(envProfile)) {
    return profileFile(envProfile);
  }

  const active = readActivePointer();
  if (active) {
    const target = profileFile(active);
    if (fs.existsSync(target)) return target;
  }

  return legacyTokenFile();
}

/** Identifier of the active profile, for display only. */
export function getActiveProfileLabel(): string {
  const envProfile = process.env.PURMEMO_PROFILE?.trim();
  if (envProfile && isSafeProfileName(envProfile)) return `${envProfile} (env)`;

  const active = readActivePointer();
  if (active && fs.existsSync(profileFile(active))) return active;

  if (fs.existsSync(legacyTokenFile())) return 'legacy (auth.json)';
  return '<none>';
}

export function getConfigDir(): string {
  return configDir();
}

export function getProfilesDir(): string {
  return profilesDir();
}

export function getLegacyTokenFile(): string {
  return legacyTokenFile();
}
