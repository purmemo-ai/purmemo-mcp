/**
 * Secure Token Storage for Purmemo MCP
 * Stores OAuth tokens securely in user's home directory
 */

import * as fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { TokenData, UserInfo, EncryptedPayload } from '../types.js';
import { getActiveTokenFile, getConfigDir } from './profile-resolver.js';

// Persisted random key file. Replaces the legacy hostname-derived key, which
// drifts on macOS whenever os.hostname() changes (Wi-Fi switch, VPN connect,
// sleep/wake) and silently locks the user out of their own tokens.
//
// Lazy-created on first encrypt/decrypt; chmod 600. Same key is read by hooks
// (purmemo_lib.ts has its own copy of this logic — must stay byte-identical;
// locked by tests/profile-resolver-contract.test.js).
const KEY_FILE_NAME = '.encryption-key';

function loadOrCreatePersistedKey(configDir: string): Buffer {
  const keyFile = path.join(configDir, KEY_FILE_NAME);
  try {
    const existing = readFileSync(keyFile, 'utf8').trim();
    if (existing.length === 64 && /^[0-9a-f]+$/.test(existing)) {
      return Buffer.from(existing, 'hex');
    }
  } catch { /* fall through to creation */ }

  // First run on this install OR malformed key file: mint a fresh one.
  const fresh = crypto.randomBytes(32);
  try {
    if (!existsSync(configDir)) {
      // Mirror ensureConfigDir() permissions for first-time creation.
      mkdirSync(configDir, { recursive: true });
      if (process.platform !== 'win32') chmodSync(configDir, 0o700);
    }
    writeFileSync(keyFile, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    // If we can't persist, callers will still get a usable key for this process,
    // but every subsequent process will mint a different one and decryption will
    // fail. Surface loudly so this isn't silent.
    console.error('Failed to persist encryption key:', (err as Error).message);
  }
  return fresh;
}

/** Legacy key derivation (pre-V2). Used only as fallback during one-shot
 *  migration of files encrypted before the persisted-key change. */
function deriveLegacyKey(): Buffer {
  const machineId = os.hostname() + os.userInfo().username;
  return crypto.createHash('sha256').update(machineId).digest();
}

class TokenStore {
  private configDir: string;
  private tokenFile: string;
  private encryptionKey: Buffer;

  /**
   * @param tokenFile Optional override for the token file path. When omitted,
   *   resolves through ProfileResolver — the single chokepoint that future
   *   multi-account support will hook into. Tests pass an explicit path.
   */
  constructor(tokenFile?: string) {
    this.configDir = getConfigDir();
    this.tokenFile = tokenFile ?? getActiveTokenFile();
    this.encryptionKey = loadOrCreatePersistedKey(this.configDir);
  }

  /** Ensure config directory exists */
  async ensureConfigDir(): Promise<void> {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      if (process.platform !== 'win32') {
        await fs.chmod(this.configDir, 0o700);
      }
    } catch (error) {
      console.error('Failed to create config directory:', error);
    }
  }

  /** Encrypt data */
  encrypt(data: TokenData): EncryptedPayload {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);

    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      iv: iv.toString('hex'),
      data: encrypted
    };
  }

  /** Decrypt data */
  decrypt(encryptedData: EncryptedPayload): TokenData {
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);

    let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted) as TokenData;
  }

  /** Save token to disk */
  async saveToken(tokenData: TokenData): Promise<void> {
    await this.ensureConfigDir();
    // Ensure the parent dir of tokenFile exists (e.g. profiles/<email>.json
    // needs profiles/ to exist when this is the first profile written).
    await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });

    const encrypted = this.encrypt(tokenData);
    await fs.writeFile(
      this.tokenFile,
      JSON.stringify(encrypted, null, 2),
      'utf8'
    );

    if (process.platform !== 'win32') {
      await fs.chmod(this.tokenFile, 0o600);
    }
  }

  /** Get stored token. Tries the current key first; on failure, tries the
   *  legacy hostname-derived key and silently migrates the file forward.
   *  See loadOrCreatePersistedKey() for the rationale. */
  async getToken(): Promise<TokenData | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.tokenFile, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      console.error('Failed to read token:', (error as Error).message);
      return null;
    }

    let encrypted: EncryptedPayload;
    try {
      encrypted = JSON.parse(raw) as EncryptedPayload;
    } catch (err) {
      console.error('Failed to read token: malformed JSON in token file:', (err as Error).message);
      return null;
    }

    try {
      return this.decrypt(encrypted);
    } catch {
      // Current key failed. Try legacy key — files written before the
      // persisted-key change used SHA-256(hostname+username).
      try {
        const legacyKey = deriveLegacyKey();
        const iv = Buffer.from(encrypted.iv, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', legacyKey, iv);
        let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        const tokenData = JSON.parse(decrypted) as TokenData;

        // Migrate: re-save under the persisted key. Best-effort — if save
        // fails we still return the decrypted token so the caller can proceed.
        try {
          await this.saveToken(tokenData);
        } catch (saveErr) {
          console.error('Token decrypt succeeded under legacy key but re-save failed:', (saveErr as Error).message);
        }
        return tokenData;
      } catch {
        // Both keys failed. Token is unrecoverable — the file was encrypted
        // under a key derived from a hostname we no longer have (ADR-039).
        // Delete it so callers see "not authenticated" and route the user
        // through re-OAuth instead of crashing on the cryptic OpenSSL error.
        try { await fs.unlink(this.tokenFile); } catch { /* best-effort */ }
        console.error(
          'pūrmemo: stored token could not be decrypted (likely a hostname change). ' +
          'Run `purmemo init` to sign in again.'
        );
        return null;
      }
    }
  }

  /** Clear stored token */
  async clearToken(): Promise<void> {
    try {
      await fs.unlink(this.tokenFile);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to clear token:', error);
      }
    }
  }

  /** Check if token exists */
  async hasToken(): Promise<boolean> {
    try {
      await fs.access(this.tokenFile);
      return true;
    } catch {
      return false;
    }
  }

  /** Get user info from stored token */
  async getUserInfo(): Promise<UserInfo | null> {
    const token = await this.getToken();
    if (!token) return null;

    return {
      user_id: token.user?.id,
      email: token.user?.email,
      tier: token.user_tier || 'free',
      memory_limit: token.memory_limit,
      expires_at: token.expires_at
    };
  }
}

export default TokenStore;
