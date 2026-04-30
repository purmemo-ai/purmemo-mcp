/**
 * One-shot migration: legacy ~/.purmemo/auth.json → profiles/<email>.json.
 *
 * Idempotent — safe to call on every CLI invocation. Behaviour:
 *   - No legacy file & no profiles → no-op (fresh install, init will create profile directly)
 *   - Legacy file present, profile missing → copy + write active pointer (legacy file kept)
 *   - Legacy file present, profile already present → no-op (already migrated)
 *
 * The legacy auth.json is intentionally NOT deleted. Mid-flight MCP server
 * processes spawned before the migration may still hold a stale path; leaving
 * the file lets them keep working until the IDE session ends. Hooks resolve
 * fresh on every fire so they pick up the new profile immediately.
 */

import * as fs from 'fs/promises';
import { existsSync } from 'node:fs';
import TokenStore from './token-store.js';
import {
  getLegacyTokenFile,
  getProfilesDir,
  profileFile,
  readActivePointer,
  writeActivePointer,
} from './profile-resolver.js';

export interface MigrationResult {
  status: 'noop' | 'migrated' | 'skipped' | 'error';
  email?: string;
  reason?: string;
}

export async function migrateLegacyAuthIfNeeded(): Promise<MigrationResult> {
  const legacy = getLegacyTokenFile();
  if (!existsSync(legacy)) {
    return { status: 'noop', reason: 'no legacy auth.json' };
  }

  // Decrypt legacy file to read email.
  const legacyStore = new TokenStore(legacy);
  const token = await legacyStore.getToken();
  if (!token) {
    return { status: 'skipped', reason: 'legacy auth.json unreadable' };
  }
  const email = token.user?.email?.trim().toLowerCase();
  if (!email) {
    return { status: 'skipped', reason: 'legacy auth.json missing user email' };
  }

  let target: string;
  try {
    target = profileFile(email);
  } catch (err) {
    return { status: 'error', reason: `invalid email in legacy file: ${(err as Error).message}` };
  }

  if (existsSync(target)) {
    // Already migrated. Make sure the active pointer points somewhere valid.
    if (!readActivePointer()) {
      try { writeActivePointer(email); } catch {}
    }
    return { status: 'noop', email, reason: 'profile already exists' };
  }

  // Copy via TokenStore so encryption stays consistent (same machineId hash).
  await fs.mkdir(getProfilesDir(), { recursive: true });
  const profileStore = new TokenStore(target);
  await profileStore.saveToken(token);
  writeActivePointer(email);

  return { status: 'migrated', email };
}
