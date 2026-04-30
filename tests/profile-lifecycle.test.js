/**
 * Profile lifecycle + migration tests.
 *
 * Verifies the full Step 1 contract:
 *   - Migration is idempotent and preserves token contents
 *   - Active pointer drives which file TokenStore (and hooks) resolve
 *   - PURMEMO_PROFILE env override beats the active pointer
 *   - Hook-side resolver agrees with TokenStore-side resolver
 *   - Missing profile falls back to legacy auth.json
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import TokenStore from '../dist/auth/token-store.js';
import {
  getActiveTokenFile,
  getActiveProfileLabel,
  listProfiles,
  profileFile,
  readActivePointer,
  writeActivePointer,
  clearActivePointer,
} from '../dist/auth/profile-resolver.js';
import { migrateLegacyAuthIfNeeded } from '../dist/auth/profile-migrator.js';

// Redirect config dir to a sandbox so we never touch the user's real
// ~/.purmemo. ProfileResolver honors PURMEMO_CONFIG_DIR for exactly this
// purpose. (os.homedir() ignores HOME on macOS, so env override is the
// reliable way to redirect.)
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'purmemo-profile-test-'));
process.env.PURMEMO_CONFIG_DIR = path.join(SANDBOX, '.purmemo');

function configDir() { return process.env.PURMEMO_CONFIG_DIR; }
function profilesDir() { return path.join(configDir(), 'profiles'); }
function legacyFile() { return path.join(configDir(), 'auth.json'); }
function activePointer() { return path.join(configDir(), 'active'); }

function resetSandbox() {
  fs.rmSync(configDir(), { recursive: true, force: true });
  fs.mkdirSync(configDir(), { recursive: true });
  delete process.env.PURMEMO_PROFILE;
}

async function writeLegacyAuth(email, accessToken = 'sk-purmemo-legacy') {
  fs.mkdirSync(configDir(), { recursive: true });
  const store = new TokenStore(legacyFile());
  await store.saveToken({
    access_token: accessToken,
    user: { id: 'u-1', email },
    user_tier: 'pro',
  });
}

async function writeProfile(email, accessToken = 'sk-purmemo-profile') {
  fs.mkdirSync(profilesDir(), { recursive: true });
  const store = new TokenStore(profileFile(email));
  await store.saveToken({
    access_token: accessToken,
    user: { id: 'u-1', email },
    user_tier: 'pro',
  });
}

// Hook-style resolver, copied verbatim from src/hooks/purmemo_lib.ts.
// If this drifts, the contract test catches it; we re-check it here too.
function hookResolveTokenFile() {
  const cd = process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
  const legacy = path.join(cd, 'auth.json');
  const env = (process.env.PURMEMO_PROFILE || '').trim();
  const safe = (n) => n && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n) && !n.includes('/');
  if (env && safe(env)) return path.join(cd, 'profiles', `${env}.json`);
  try {
    const ptr = fs.readFileSync(path.join(cd, 'active'), 'utf8').trim();
    if (ptr && safe(ptr)) {
      const target = path.join(cd, 'profiles', `${ptr}.json`);
      if (fs.existsSync(target)) return target;
    }
  } catch {}
  return legacy;
}

after(() => {
  delete process.env.PURMEMO_CONFIG_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('Profile resolver — fallback chain', () => {
  beforeEach(() => resetSandbox());

  it('falls back to legacy auth.json when no profile is configured', () => {
    assert.strictEqual(getActiveTokenFile(), legacyFile());
    assert.strictEqual(hookResolveTokenFile(), legacyFile());
  });

  it('active pointer overrides legacy when the target profile exists', async () => {
    await writeProfile('alice@purmemo.ai');
    writeActivePointer('alice@purmemo.ai');
    assert.strictEqual(getActiveTokenFile(), profileFile('alice@purmemo.ai'));
    assert.strictEqual(hookResolveTokenFile(), profileFile('alice@purmemo.ai'));
  });

  it('falls back to legacy when active pointer points at a missing profile', () => {
    writeActivePointer('ghost@purmemo.ai');
    assert.strictEqual(getActiveTokenFile(), legacyFile());
    assert.strictEqual(hookResolveTokenFile(), legacyFile());
  });

  it('PURMEMO_PROFILE env beats the active pointer', async () => {
    await writeProfile('alice@purmemo.ai');
    await writeProfile('bob@purmemo.ai');
    writeActivePointer('alice@purmemo.ai');
    process.env.PURMEMO_PROFILE = 'bob@purmemo.ai';
    try {
      assert.strictEqual(getActiveTokenFile(), profileFile('bob@purmemo.ai'));
      assert.strictEqual(hookResolveTokenFile(), profileFile('bob@purmemo.ai'));
    } finally {
      delete process.env.PURMEMO_PROFILE;
    }
  });

  it('rejects path-traversal-shaped profile names', () => {
    process.env.PURMEMO_PROFILE = '../../../etc/passwd';
    try {
      assert.strictEqual(getActiveTokenFile(), legacyFile());
    } finally {
      delete process.env.PURMEMO_PROFILE;
    }
  });
});

describe('Profile listing + label', () => {
  beforeEach(() => resetSandbox());

  it('listProfiles returns sorted emails', async () => {
    await writeProfile('charlie@purmemo.ai');
    await writeProfile('alice@purmemo.ai');
    await writeProfile('bob@purmemo.ai');
    assert.deepStrictEqual(listProfiles(), [
      'alice@purmemo.ai', 'bob@purmemo.ai', 'charlie@purmemo.ai',
    ]);
  });

  it('label says <none> on a fresh sandbox', () => {
    assert.strictEqual(getActiveProfileLabel(), '<none>');
  });

  it('label says legacy when only auth.json exists', async () => {
    await writeLegacyAuth('legacy@purmemo.ai');
    assert.strictEqual(getActiveProfileLabel(), 'legacy (auth.json)');
  });

  it('label includes (env) when PURMEMO_PROFILE is set', () => {
    process.env.PURMEMO_PROFILE = 'envuser@purmemo.ai';
    try {
      assert.strictEqual(getActiveProfileLabel(), 'envuser@purmemo.ai (env)');
    } finally {
      delete process.env.PURMEMO_PROFILE;
    }
  });
});

describe('Migration: legacy auth.json → profiles/<email>.json', () => {
  beforeEach(() => resetSandbox());

  it('no-op on fresh install (no legacy file)', async () => {
    const r = await migrateLegacyAuthIfNeeded();
    assert.strictEqual(r.status, 'noop');
    assert.strictEqual(listProfiles().length, 0);
  });

  it('copies legacy auth.json into profiles/<email>.json and writes active pointer', async () => {
    await writeLegacyAuth('legacy@purmemo.ai', 'sk-purmemo-original');
    const r = await migrateLegacyAuthIfNeeded();
    assert.strictEqual(r.status, 'migrated');
    assert.strictEqual(r.email, 'legacy@purmemo.ai');
    assert.ok(fs.existsSync(profileFile('legacy@purmemo.ai')));
    assert.strictEqual(readActivePointer(), 'legacy@purmemo.ai');

    const store = new TokenStore(profileFile('legacy@purmemo.ai'));
    const token = await store.getToken();
    assert.strictEqual(token.access_token, 'sk-purmemo-original');
    assert.strictEqual(token.user.email, 'legacy@purmemo.ai');
  });

  it('leaves the legacy auth.json in place after migration (compat for in-flight servers)', async () => {
    await writeLegacyAuth('legacy@purmemo.ai');
    await migrateLegacyAuthIfNeeded();
    assert.ok(fs.existsSync(legacyFile()), 'legacy auth.json must NOT be deleted');
  });

  it('idempotent — second run is a no-op', async () => {
    await writeLegacyAuth('legacy@purmemo.ai');
    const first = await migrateLegacyAuthIfNeeded();
    const second = await migrateLegacyAuthIfNeeded();
    assert.strictEqual(first.status, 'migrated');
    assert.strictEqual(second.status, 'noop');
  });

  it('skips when legacy file has no email', async () => {
    fs.mkdirSync(configDir(), { recursive: true });
    const store = new TokenStore(legacyFile());
    await store.saveToken({ access_token: 'sk-orphan', user: {} });
    const r = await migrateLegacyAuthIfNeeded();
    assert.strictEqual(r.status, 'skipped');
  });
});

describe('TokenStore reads through resolver', () => {
  beforeEach(() => resetSandbox());

  it('reads alice when active pointer is alice', async () => {
    await writeProfile('alice@purmemo.ai', 'sk-alice');
    await writeProfile('bob@purmemo.ai', 'sk-bob');
    writeActivePointer('alice@purmemo.ai');

    const store = new TokenStore(); // uses resolver
    const t = await store.getToken();
    assert.strictEqual(t.access_token, 'sk-alice');
  });

  it('switches when active pointer changes', async () => {
    await writeProfile('alice@purmemo.ai', 'sk-alice');
    await writeProfile('bob@purmemo.ai', 'sk-bob');

    writeActivePointer('alice@purmemo.ai');
    let t = await new TokenStore().getToken();
    assert.strictEqual(t.access_token, 'sk-alice');

    writeActivePointer('bob@purmemo.ai');
    t = await new TokenStore().getToken();
    assert.strictEqual(t.access_token, 'sk-bob');
  });
});
