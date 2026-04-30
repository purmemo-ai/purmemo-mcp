/**
 * Secure Token Storage for Purmemo MCP
 * Stores OAuth tokens securely in user's home directory
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { TokenData, UserInfo, EncryptedPayload } from '../types.js';
import { getActiveTokenFile, getConfigDir } from './profile-resolver.js';

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
    this.encryptionKey = this.getEncryptionKey();
  }

  /** Get or generate encryption key for token storage */
  private getEncryptionKey(): Buffer {
    const machineId = os.hostname() + os.userInfo().username;
    return crypto.createHash('sha256').update(machineId).digest();
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

  /** Get stored token */
  async getToken(): Promise<TokenData | null> {
    try {
      const data = await fs.readFile(this.tokenFile, 'utf8');
      const encrypted = JSON.parse(data) as EncryptedPayload;
      return this.decrypt(encrypted);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error('Failed to read token:', (error as Error).message);
      return null;
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
