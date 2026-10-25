/**
 * Accounts — per-call account selection over the accounts signed in on THIS machine (2026-10-25).
 *
 * A person can have several purmemo accounts (personal, work, …) signed in on one machine
 * (`purmemo add`). The server still starts on ONE account — the active profile — and that stays the
 * default for every call, every hook and every auto-capture. A tool call may name another signed-in
 * account with `account: "<email>"`; that one call then runs with that account's key, bound to the
 * call only (AsyncLocalStorage), never by switching the active pointer or any global.
 *
 * Rules (design thread 2026-08-05 + judged debate debate3-1792966568, 2026-10-25):
 *  - The selector is a choice among signed-in profiles, never an identity claim. Anything that is not
 *    exactly one of them is refused BEFORE any network call. Remote (hosted) mode never offers or
 *    accepts it: its profiles directory belongs to the host, not to the caller.
 *  - Credentials never leave this module except into the API client for that one call. Nothing here
 *    prints, logs or returns a key.
 *  - Every call that runs on a NON-default account is written to an audit log (no content, no key).
 *  - Side channels that file under a fixed identity (the shadow mirror) must stay off for a non-default
 *    account: `isAlternateAccountScope()` is what they check.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import TokenStore from './token-store.js';
import {
  listProfiles, profileFile, readActivePointer, getConfigDir, getActiveTokenFile, getLegacyTokenFile,
} from './profile-resolver.js';

export class AccountSelectorError extends Error {
  constructor(message: string) { super(message); this.name = 'AccountSelectorError'; }
}

export type AccountScope = { email: string; isDefault: boolean };

const scopeStore = new AsyncLocalStorage<AccountScope>();

export function isRemoteMode(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  return argv.includes('--remote') || env.PURMEMO_REMOTE === '1';
}

/** The account this process started on (PURMEMO_PROFILE, else the active pointer), or null for legacy/none. */
export function defaultAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = getActiveTokenFile();
  if (file === getLegacyTokenFile()) return null;
  const envProfile = env.PURMEMO_PROFILE?.trim().toLowerCase();
  if (envProfile) return envProfile;
  return readActivePointer();
}

/** Signed-in accounts on this machine: profiles whose token file exists. Sorted, lowercase. */
export function signedInAccounts(): string[] {
  return listProfiles()
    .map((e) => e.toLowerCase())
    .filter((e) => { try { return fs.statSync(profileFile(e)).size > 0; } catch { return false; } });
}

/** Per-call selection is offered only locally and only when there is more than one account to choose from. */
export function multiAccountEnabled(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (isRemoteMode(env, argv)) return false;
  if (env.PURMEMO_MULTI_ACCOUNT === '0') return false;
  return signedInAccounts().length >= 2;
}

/**
 * Validate a selector against the signed-in set. Returns the canonical email.
 * Throws AccountSelectorError for anything else, with no network call made.
 */
export function validateSelector(selector: unknown, env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string {
  if (isRemoteMode(env, argv)) {
    throw new AccountSelectorError('Choosing an account per call is only available in the local purmemo connector.');
  }
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new AccountSelectorError('account must be the email of an account signed in on this machine.');
  }
  const want = selector.trim().toLowerCase();
  const accounts = signedInAccounts();
  if (!accounts.includes(want)) {
    const list = accounts.length ? accounts.join(', ') : 'none';
    throw new AccountSelectorError(`"${selector}" is not an account signed in on this machine. Signed in: ${list}. Add one with: purmemo-mcp-setup add`);
  }
  return want;
}

/** The access token of one signed-in account. Internal: callers get a key only to make that account's calls. */
async function tokenFor(email: string): Promise<string> {
  const store = new TokenStore(profileFile(email));
  const tok = await store.getToken();
  if (!tok?.access_token) {
    throw new AccountSelectorError(`The saved sign-in for ${email} could not be read on this machine. Reconnect it with: purmemo-mcp-setup add`);
  }
  return tok.access_token;
}

export type ApiKeyRunner = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Run `fn` as `selector`'s account. The default account (or no selector) runs `fn` unchanged, so
 * single-account behaviour is byte-for-byte what it was. A non-default account runs inside
 * `runWithApiKey(key, …)` plus an account scope that side channels can see.
 */
export async function runAsAccount<T>(selector: unknown, runWithApiKey: ApiKeyRunner, fn: () => Promise<T>): Promise<{ result: T; scope: AccountScope | null }> {
  if (selector === undefined || selector === null || selector === '') {
    return { result: await fn(), scope: null };
  }
  const email = validateSelector(selector);
  const def = defaultAccount();
  if (def && email === def.toLowerCase()) {
    return { result: await scopeStore.run({ email, isDefault: true }, fn), scope: { email, isDefault: true } };
  }
  const key = await tokenFor(email);
  const scope = { email, isDefault: false };
  const result = await scopeStore.run(scope, () => runWithApiKey(key, fn));
  return { result, scope };
}

/**
 * Run `fn` bound to `selector`'s own key, ALWAYS explicitly (never the process default). For code callers
 * (the purmemo-ops CLI): an automated job states its account every time.
 */
export async function runBoundToAccount<T>(selector: unknown, runWithApiKey: ApiKeyRunner, fn: () => Promise<T>): Promise<{ result: T; scope: AccountScope }> {
  const email = validateSelector(selector);
  const def = defaultAccount();
  const scope = { email, isDefault: !!def && email === def.toLowerCase() };
  const key = await tokenFor(email);
  const result = await scopeStore.run(scope, () => runWithApiKey(key, fn));
  return { result, scope };
}

/** The account scope of the current call, or null when the call runs on the default account. */
export function currentAccountScope(): AccountScope | null {
  return scopeStore.getStore() || null;
}

/** True while running on a non-default account. Fixed-identity side channels must stay off. */
export function isAlternateAccountScope(): boolean {
  const s = scopeStore.getStore();
  return !!s && !s.isDefault;
}

/** Key for a destination account in a transfer (validated first). Never returned to a model. */
export async function destinationCredential(selector: unknown): Promise<{ email: string; credential: string }> {
  const email = validateSelector(selector);
  return { email, credential: await tokenFor(email) };
}

/** Append one audit line (no content, no key). Best effort: never fails the call it records. */
export function auditAccountUse(entry: Record<string, unknown>): void {
  try {
    const file = path.join(getConfigDir(), 'account-audit.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch { /* audit is best effort */ }
}

/** The JSON-schema property added to account-aware tools when several accounts are signed in. */
export function accountProperty(accounts: string[], defaultEmail: string | null) {
  const others = accounts.filter((a) => a !== (defaultEmail || '').toLowerCase());
  return {
    type: 'string',
    enum: accounts,
    description:
      `Which purmemo account this call uses. Omit it for the default account${defaultEmail ? ` (${defaultEmail})` : ''}. ` +
      `Name another account only when the user asked for it or the content clearly belongs there` +
      (others.length ? ` (${others.join(', ')})` : '') +
      `. Results are labelled with the account. Never copy content between accounts unless the user asked.`,
  };
}
