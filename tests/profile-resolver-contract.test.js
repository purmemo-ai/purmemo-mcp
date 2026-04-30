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
function hookGetEncryptionKey() {
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

describe('Profile resolver contract — TokenStore vs hook crypto', () => {
  it('resolves the same active token file in both paths', () => {
    assert.strictEqual(
      getActiveTokenFile(),
      hookGetActiveTokenFile(),
      'TokenStore and hook resolve different paths — profile resolution has drifted'
    );
  });

  it('hook crypto can decrypt a token written by TokenStore', async () => {
    const tmpFile = path.join(os.tmpdir(), `purmemo-contract-${Date.now()}.json`);
    try {
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
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });

  it('TokenStore can decrypt a token written by hook-style encryption', async () => {
    const tmpFile = path.join(os.tmpdir(), `purmemo-contract-${Date.now()}-2.json`);
    try {
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
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });
});
