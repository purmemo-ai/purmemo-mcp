/**
 * Profile Resolver Contract Test
 *
 * Hooks ship as standalone .js files in ~/.claude/hooks/ and cannot import
 * TokenStore. They duplicate the crypto and path-resolution logic. This test
 * locks the two read paths together — if either drifts, hooks silently auth
 * as nobody (the exact failure mode that caused Jode-Leigh's cross-account
 * saves before ADR-031, 2026-04-24).
 *
 * Verifies:
 *   1. Both paths resolve the same active-token-file location.
 *   2. A token written via TokenStore decrypts correctly via the hook's
 *      inline crypto, and vice versa.
 *
 * If this test fails, do NOT update the test to match — the two crypto
 * paths have actually drifted and need to be reconciled.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import TokenStore from '../dist/auth/token-store.js';
import { getActiveTokenFile } from '../dist/auth/profile-resolver.js';

// Mirror of hook crypto — copied verbatim from src/hooks/purmemo_lib.ts.
// If this drifts from the source, the test will fail.
//
// V2: persisted random key file at ~/.purmemo/.encryption-key. Lazy-created
// on first call. Replaces the legacy hostname-derived key, which drifts on
// macOS with Wi-Fi/VPN changes.
function hookGetEncryptionKey() {
  const configDir = process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
  const keyFile = path.join(configDir, '.encryption-key');
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length === 64 && /^[0-9a-f]+$/.test(existing)) {
      return Buffer.from(existing, 'hex');
    }
  } catch {}
  const fresh = crypto.randomBytes(32);
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      if (process.platform !== 'win32') fs.chmodSync(configDir, 0o700);
    }
    fs.writeFileSync(keyFile, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch {}
  return fresh;
}

function hookDeriveLegacyKey() {
  const machineId = os.hostname() + os.userInfo().username;
  return crypto.createHash('sha256').update(machineId).digest();
}
// Mirror of profile-resolver.ts:getActiveTokenFile() — same fallback chain.
// PURMEMO_PROFILE → active pointer → legacy auth.json.
function hookGetActiveTokenFile() {
  const cd = process.env.PURMEMO_CONFIG_DIR || path.join(os.homedir(), '.purmemo');
  const legacy = path.join(cd, 'auth.json');
  const safe = (n) => n && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n) && !n.includes('/');
  const env = (process.env.PURMEMO_PROFILE || '').trim();
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
function hookDecryptTokenFile(tokenFile) {
  const encryptedData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', hookGetEncryptionKey(), iv);
  let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// Each test runs in an isolated PURMEMO_CONFIG_DIR so the persisted-key
// file lives in tmp, not in the user's real ~/.purmemo.
async function withIsolatedConfigDir(fn) {
  const original = process.env.PURMEMO_CONFIG_DIR;
  const tmp = path.join(os.tmpdir(), `purmemo-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.PURMEMO_CONFIG_DIR = tmp;
  try {
    return await fn(tmp);
  } finally {
    if (original === undefined) delete process.env.PURMEMO_CONFIG_DIR;
    else process.env.PURMEMO_CONFIG_DIR = original;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

describe('Profile resolver contract — TokenStore vs hook crypto', () => {
  it('resolves the same active token file in both paths', () => {
    assert.strictEqual(
      getActiveTokenFile(),
      hookGetActiveTokenFile(),
      'TokenStore and hook resolve different paths — profile resolution has drifted'
    );
  });

  it('hook crypto can decrypt a token written by TokenStore', async () => {
    await withIsolatedConfigDir(async (cd) => {
      const tmpFile = path.join(cd, 'token.json');
      const store = new TokenStore(tmpFile);
      const original = {
        access_token: 'sk-purmemo-test-contract-key',
        refresh_token: 'refresh-test',
        expires_at: Date.now() + 3600_000,
        user: { id: 'test-user', email: 'test@purmemo.ai' },
        user_tier: 'pro',
      };
      await store.saveToken(original);

      const decryptedByHook = hookDecryptTokenFile(tmpFile);
      assert.strictEqual(
        decryptedByHook.access_token,
        original.access_token,
        'Hook crypto failed to decrypt TokenStore output — crypto paths have drifted'
      );
      assert.strictEqual(decryptedByHook.user.email, 'test@purmemo.ai');
      assert.strictEqual(decryptedByHook.user_tier, 'pro');
    });
  });

  it('TokenStore can decrypt a token written by hook-style encryption', async () => {
    await withIsolatedConfigDir(async (cd) => {
      const tmpFile = path.join(cd, 'token-reverse.json');
      const original = {
        access_token: 'sk-purmemo-test-reverse',
        user: { id: 'test', email: 'reverse@purmemo.ai' },
        user_tier: 'free',
      };
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', hookGetEncryptionKey(), iv);
      let encrypted = cipher.update(JSON.stringify(original), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({ iv: iv.toString('hex'), data: encrypted }, null, 2)
      );

      const store = new TokenStore(tmpFile);
      const decryptedByStore = await store.getToken();
      assert.ok(decryptedByStore, 'TokenStore returned null reading hook-encrypted file');
      assert.strictEqual(decryptedByStore.access_token, original.access_token);
      assert.strictEqual(decryptedByStore.user.email, 'reverse@purmemo.ai');
    });
  });

  it('TokenStore migrates legacy-key-encrypted tokens forward on first read', async () => {
    await withIsolatedConfigDir(async (cd) => {
      const tmpFile = path.join(cd, 'token-legacy.json');
      const original = {
        access_token: 'sk-purmemo-legacy-encrypted',
        user: { id: 'legacy', email: 'legacy@purmemo.ai' },
        user_tier: 'free',
      };

      // Write the file using ONLY the legacy hostname-derived key.
      const legacyKey = hookDeriveLegacyKey();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', legacyKey, iv);
      let encrypted = cipher.update(JSON.stringify(original), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const legacyPayload = { iv: iv.toString('hex'), data: encrypted };
      fs.writeFileSync(tmpFile, JSON.stringify(legacyPayload, null, 2));

      // First read: should decrypt via fallback and migrate the file.
      const store = new TokenStore(tmpFile);
      const got = await store.getToken();
      assert.ok(got, 'getToken returned null for legacy-encrypted file');
      assert.strictEqual(got.access_token, original.access_token);

      // File on disk should now be re-encrypted under the persisted key.
      const onDisk = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
      assert.notStrictEqual(onDisk.iv, legacyPayload.iv, 'token file IV unchanged after migration');
      assert.notStrictEqual(onDisk.data, legacyPayload.data, 'token file ciphertext unchanged after migration');

      // Second read: must succeed via the persisted-key fast path (legacy key
      // is not consulted on this read; identical content proves migration stuck).
      const got2 = await store.getToken();
      assert.ok(got2);
      assert.strictEqual(got2.access_token, original.access_token);
    });
  });

  it('hook loadApiKey() migrates legacy-key-encrypted tokens forward', async () => {
    // Mirror of the hook's loadApiKey() fallback path. Must stay in sync.
    function hookLoadApiKeyMigrate(tokenFile) {
      const encryptedData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      const iv = Buffer.from(encryptedData.iv, 'hex');
      try {
        const d = crypto.createDecipheriv('aes-256-cbc', hookGetEncryptionKey(), iv);
        let out = d.update(encryptedData.data, 'hex', 'utf8'); out += d.final('utf8');
        return JSON.parse(out).access_token || null;
      } catch {}
      const ld = crypto.createDecipheriv('aes-256-cbc', hookDeriveLegacyKey(), iv);
      let out = ld.update(encryptedData.data, 'hex', 'utf8'); out += ld.final('utf8');
      const tokenData = JSON.parse(out);
      const newIv = crypto.randomBytes(16);
      const c = crypto.createCipheriv('aes-256-cbc', hookGetEncryptionKey(), newIv);
      let re = c.update(JSON.stringify(tokenData), 'utf8', 'hex'); re += c.final('hex');
      fs.writeFileSync(tokenFile, JSON.stringify({ iv: newIv.toString('hex'), data: re }, null, 2));
      return tokenData.access_token || null;
    }

    await withIsolatedConfigDir(async (cd) => {
      const tmpFile = path.join(cd, 'token-hook-legacy.json');
      const original = { access_token: 'sk-hook-legacy', user: { email: 'h@purmemo.ai' } };
      const iv = crypto.randomBytes(16);
      const c = crypto.createCipheriv('aes-256-cbc', hookDeriveLegacyKey(), iv);
      let enc = c.update(JSON.stringify(original), 'utf8', 'hex'); enc += c.final('hex');
      fs.writeFileSync(tmpFile, JSON.stringify({ iv: iv.toString('hex'), data: enc }, null, 2));

      const apiKey = hookLoadApiKeyMigrate(tmpFile);
      assert.strictEqual(apiKey, original.access_token);

      // After migration, plain hookDecryptTokenFile (which uses the persisted
      // key) must succeed.
      const got = hookDecryptTokenFile(tmpFile);
      assert.strictEqual(got.access_token, original.access_token);
    });
  });
});
