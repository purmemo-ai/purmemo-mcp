/**
 * Keychain — secure token storage via OS keychain (keytar).
 *
 * Tokens are stored in the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service) rather than on disk. This means:
 * - Tokens are not accessible to other apps without user permission
 * - Tokens survive app uninstall/reinstall (user controls them via Keychain Access)
 * - No plaintext token ever written to the filesystem
 *
 * Falls back to electron-store if keytar is unavailable (e.g. CI/Linux without
 * a secret service daemon running).
 */

import Store from 'electron-store';

const SERVICE = 'ai.purmemo.desktop';
const ACCESS_ACCOUNT = 'access_token';
const REFRESH_ACCOUNT = 'refresh_token';

interface FallbackSchema {
  accessToken: string;
  refreshToken: string;
}

// Lazy-load keytar — it's a native module and may not be available in all envs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let keytar: any = null;
let keytarAvailable = false;

// Fallback store used when keytar is unavailable
const fallback = new Store<FallbackSchema>({
  name: 'purmemo-tokens',
  encryptionKey: 'purmemo-token-fallback-v1',
});

async function loadKeytar(): Promise<boolean> {
  if (keytarAvailable) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    keytar = require('keytar');
    keytarAvailable = true;
    return true;
  } catch {
    console.warn('[keychain] keytar unavailable — falling back to encrypted store');
    return false;
  }
}

export async function getAccessToken(): Promise<string> {
  if (await loadKeytar()) {
    return (await keytar.getPassword(SERVICE, ACCESS_ACCOUNT)) ?? '';
  }
  return fallback.get('accessToken', '');
}

export async function getRefreshToken(): Promise<string> {
  if (await loadKeytar()) {
    return (await keytar.getPassword(SERVICE, REFRESH_ACCOUNT)) ?? '';
  }
  return fallback.get('refreshToken', '');
}

export async function setAccessToken(token: string): Promise<void> {
  if (await loadKeytar()) {
    await keytar.setPassword(SERVICE, ACCESS_ACCOUNT, token);
    return;
  }
  fallback.set('accessToken', token);
}

export async function setRefreshToken(token: string): Promise<void> {
  if (await loadKeytar()) {
    await keytar.setPassword(SERVICE, REFRESH_ACCOUNT, token);
    return;
  }
  fallback.set('refreshToken', token);
}

export async function deleteTokens(): Promise<void> {
  if (await loadKeytar()) {
    await Promise.all([
      keytar.deletePassword(SERVICE, ACCESS_ACCOUNT),
      keytar.deletePassword(SERVICE, REFRESH_ACCOUNT),
    ]);
    return;
  }
  fallback.delete('accessToken');
  fallback.delete('refreshToken');
}
