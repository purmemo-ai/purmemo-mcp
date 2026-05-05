# ADR-039: Encryption Key Derivation — Persisted Random Key Supersedes Hostname-Derived Key

**Date:** 2026-05-04
**Status:** Accepted — shipped v15.7.18
**Deciders:** Chris Oladapo
**Supersedes:** Hostname-based key derivation introduced in v12.8.0 (commit `03aa96d`)
**Related:** ADR-031 (api-key leak prevention — Phase 3 fingerprint design needs revision in light of this finding), ADR-035 (multi-account profiles — referenced "hooks crypto dedup" as carry-forward debt; this ADR keeps the duplication, fixes the broken primitive)

## Context and Problem Statement

`purmemo-mcp` stores OAuth tokens at-rest under AES-256-CBC. The encryption key was derived from `SHA-256(os.hostname() + os.userInfo().username)` (`src/auth/token-store.ts:31` and the byte-identical mirror in `src/hooks/purmemo_lib.ts:222`).

The threat model was casual disclosure — somebody scrolling through dotfiles, a leaked backup, a screen-share. AES-256 is overkill for that, but the derivation primitive was the actual problem: **`os.hostname()` is not stable on macOS laptops.**

Empirically observed on the maintainer's machine over a 24-hour period (2026-05-03 → 2026-05-04):
- `Kriss-MacBook-Pro.local`
- `Mac.lan`
- An ephemeral hostname assigned during a NordVPN session (no longer reproducible)

Each time `os.hostname()` returns a different value, the derived key changes, and all previously-encrypted token files become unreadable with the cryptic error:

```
Failed to read token: error:1C800064:Provider routines::bad decrypt
```

Causes of `os.hostname()` flipping on macOS:
- DHCP-supplied hostname when joining a new Wi-Fi network
- Bonjour/mDNS-derived `.local` form
- VPN connect/disconnect (NordVPN, Tailscale, corporate VPNs all push different DHCP leases)
- Sleep/wake cycles
- Router-side device renaming

`scutil --get LocalHostName` (which returns a user-controlled, stable value like `Kriss-MacBook-Pro`) does NOT change with network state — but Node's `os.hostname()` calls `gethostname(3)` directly and reflects whatever the kernel currently has, which is none of those.

This silently locks active users out of their own tokens. The breakage is invisible to monitoring (no exception, no telemetry — just an unreadable file). Recovery requires `npx purmemo-mcp setup` to re-OAuth, which the user has to figure out themselves.

## Decision Drivers

- **Stability across network state changes.** The encryption key must NOT change when the user toggles VPN, switches Wi-Fi, or sleep/wakes the machine.
- **Backwards compatibility.** Existing users have token files encrypted under the old hostname-derived key. Forcing every user to re-OAuth on upgrade is unacceptable.
- **No new auth surface.** ADR-031 invariant: `auth.json` (and its profiles successor) is the single source of truth. The encryption-key file must be metadata, not auth.
- **No new dependency.** Native modules like `keytar` (macOS Keychain integration) require platform-specific compilation and break the curl-installer simplicity from ADR-035.
- **Survives `purmemo --update` reconciliation.** ADR-037 documented the pattern of `--update` overwriting hand-deployed state. Our new file must NOT be touched by reconcile.
- **`feedback_auth_state_visibility` honored.** Auth state changes must be visible. Migration is intra-account self-recovery (not cross-account); a quiet single-line stderr is appropriate, not a permanent audit log.

## Options Considered

### Option 1: Persisted random key file at `~/.purmemo/.encryption-key`

- **Description:** Generate 32 random bytes on first encrypt, hex-encode, write to `~/.purmemo/.encryption-key` with chmod 600. Read on every subsequent encrypt/decrypt.
- **Pros:**
  - Stable across network changes, sleep/wake, VPN toggles. Tied to filesystem state, not network state.
  - No new dependencies. Pure stdlib (`crypto.randomBytes`, `fs`).
  - Portable via Time Machine restore (file moves with home dir).
  - Per-user isolation (file is in user's home, chmod 600).
  - Compatible with multi-account profile design (one key file → many profile files, all encrypted under same key).
- **Cons:**
  - File deletion = loss of access to all tokens (mitigated by automatic re-OAuth flow).
  - If user copies `~/.purmemo` to another machine, both machines share the same key (acceptable — same trust boundary).

### Option 2: macOS Keychain (via `keytar` or `security` command)

- **Description:** Store the encryption key in the OS keychain.
- **Pros:**
  - Strongest at-rest protection on macOS.
  - Stable across reboots and network changes.
- **Cons:**
  - Native module (`keytar`) requires compilation per Node version + arch — breaks the lightweight npm install.
  - Linux/Windows variants behave differently (libsecret on Linux requires a DBus session; Windows Credential Manager has its own quirks).
  - Time Machine restore doesn't bring keychain entries with it unless iCloud Keychain is enabled.
  - Adds a permission prompt the first time the CLI runs.

### Option 3: Stable OS-derived ID (IOPlatformUUID)

- **Description:** Read `ioreg -d2 -c IOPlatformExpertDevice | grep IOPlatformUUID`.
- **Pros:**
  - Hardware-stable. Survives reinstalls and network changes.
- **Cons:**
  - macOS-only. Linux equivalent is `/etc/machine-id` (different format, different stability guarantees), Windows has its own.
  - Requires shelling out to `ioreg` per process — cold-start latency.
  - "Hardware ID" reads as more invasive than a random file.

### Option 4: No encryption — just chmod 600 the plaintext

- **Description:** Drop the encryption layer entirely. The file is already chmod 600.
- **Pros:**
  - Smallest code, simplest reasoning.
- **Cons:**
  - Loses defense-in-depth against backups, screen-share artifacts, support-bundle uploads.
  - Visible regression even if effective protection is similar.

## Decision Outcome

**Chosen option: Option 1 — Persisted random key file at `~/.purmemo/.encryption-key`.**

### Rationale

The decision criteria all favor Option 1:

| Criterion | Option 1 | Option 2 | Option 3 | Option 4 |
|---|---|---|---|---|
| Stable across network changes | ✅ | ✅ | ✅ | ✅ (no key) |
| No new native deps | ✅ | ❌ | ✅ | ✅ |
| Cross-platform | ✅ | ⚠️ | ❌ | ✅ |
| Survives Time Machine | ✅ | ❌ | ✅ | ✅ |
| Defense-in-depth maintained | ✅ | ✅ | ✅ | ❌ |

Option 1 wins on every axis except "strongest possible at-rest protection," where Option 2's Keychain is theoretically stronger — but the threat model (casual disclosure, not nation-state adversary) doesn't justify the dependency cost.

### Migration

**Silent and automatic.** On first `getToken()` after upgrade:

1. Try the new persisted key — fails (file doesn't exist yet).
2. Fall back to the legacy hostname-derived key — succeeds (because the user is currently on the same hostname they wrote the file with).
3. Re-encrypt under the persisted key, atomic write.
4. From then on, network/Wi-Fi/VPN changes never break the token.

**Edge case:** if a user's hostname changed *between* writing the token and upgrading to this fix, the legacy fallback also fails. They see the existing "Failed to read token" error, run `purmemo init`, get fresh tokens written under the persisted key. No worse than today's behavior.

The migration emits no permanent audit row — only a stderr line if either decrypt path fails. `feedback_auth_state_visibility` is honored: the threat model in that rule is *cross-account* silent success (Jode-Leigh incident), and migration cannot succeed for the wrong user (it only succeeds when the legacy key — bound to this user's hostname — decrypts a file already in this user's home directory). Stretching the rule to include intra-account self-recovery would mean every fix surfaces a banner — noise without security value.

## Implementation

Mirror in two files (locked by `tests/profile-resolver-contract.test.js`):

1. **`src/auth/token-store.ts`**:
   - `loadOrCreatePersistedKey(configDir)` reads/creates `~/.purmemo/.encryption-key` (32 bytes, hex, chmod 600, lazy-created)
   - `deriveLegacyKey()` preserves `SHA-256(hostname + username)`
   - `getToken()` tries V2 → falls back to legacy → on legacy success, re-saves under V2

2. **`src/hooks/purmemo_lib.ts`** (standalone, ships to `~/.claude/hooks/`):
   - Same V2 + legacy logic, byte-identical to token-store
   - `loadApiKey()` mirrors the migration dance

3. **`tests/profile-resolver-contract.test.js`**:
   - Each test runs in isolated `PURMEMO_CONFIG_DIR` so the persisted key doesn't pollute real `~/.purmemo`
   - Two new migration tests verify legacy → V2 round-trip via both surfaces

## Implications for ADR-031 Phase 3

ADR-031 Phase 3 plans a server-side client-identity fingerprint computed as:

> `SHA-256(hostname + machine-id + os_user)` sent as `X-Purmemo-Client-Identity`

**Hostname is unstable.** A fingerprint built on it would flip every time the user toggles VPN — making "first identity binds, subsequent identities flagged" produce constant false positives. Phase 3 should be revised to use:

- `IOPlatformUUID` (macOS) / `/etc/machine-id` (Linux) / Windows machine GUID — true hardware-stable identifiers
- OR: the same persisted random key file (`~/.purmemo/.encryption-key`) reused as a "client identity token"

The latter is appealing because it ties the server-side fingerprint to the same artifact that proves client-side identity (the key that decrypts the local token). Loss of the file = loss of identity; copy of the file = same identity. This matches user mental model.

**Action:** when ADR-031 Phase 3 is opened, revisit fingerprint design with this finding.

## Consequences

### Positive
- VPN toggles, Wi-Fi switches, and sleep/wake no longer break authentication.
- One-time silent migration for ~99% of existing users — no manual intervention required.
- Closes a class of bug that was producing "Failed to read token" support tickets with no obvious cause.
- Surfaces a constraint for ADR-031 Phase 3 fingerprint design.

### Negative
- One more file in `~/.purmemo`. Listed in user's dotfiles directory.
- Edge-case users (hostname changed between token write and upgrade) need to re-OAuth. No worse than today.
- Dual-implementation maintenance burden in `token-store.ts` and `purmemo_lib.ts`. Already a known carry-forward debt from ADR-035; this ADR doesn't close it.

### Risks and mitigations
- **Risk:** `purmemo --update` reconcile path overwrites `.encryption-key`.
  **Mitigation:** Verified `setup.ts` writes only to `~/.purmemo/.scrubbed-shell-config-v15-7-6` sentinel, not the key file. Test added.
- **Risk:** User wipes `~/.purmemo` during cleanup.
  **Mitigation:** Existing behavior (re-OAuth required) — no regression.
- **Risk:** Filesystem permission inheritance issues (umask, NFS, etc.).
  **Mitigation:** Explicit chmod 600 on creation; if umask is restrictive enough that even owner can't read, that's the same broken state for every dotfile.

## Files Touched

- `src/auth/token-store.ts` — `loadOrCreatePersistedKey`, `deriveLegacyKey`, `getToken` migration
- `src/hooks/purmemo_lib.ts` — mirrored V2 + legacy logic in `loadApiKey`
- `tests/profile-resolver-contract.test.js` — isolated config dir, 2 new migration tests
- `package.json`, `server.json`, `src/manifest.json`, `bundle/manifest.json` — version bump to 15.7.18

## Validation

Real-world: 2 of 3 broken token files on the dev machine were recovered via fallback and re-encrypted under the persisted key. The 3rd (encrypted under an ephemeral NordVPN-era hostname not currently reproducible) was unrecoverable — fresh OAuth required, exactly as documented. After fix, all 3 files decrypt via V2 fast path on subsequent reads.

Tests: 114/114 pass.

## Review Date

2026-11-04 (six months) — revisit if:
- Cross-platform issues surface (Linux/Windows variants behaving differently than macOS)
- ADR-031 Phase 3 fingerprint work begins (need to coordinate)
- Multi-machine sync demand surfaces (would require sharing `.encryption-key` across machines, which works but isn't designed for)

## References

- Related: ADR-031 (Phase 3 fingerprint needs revision in light of hostname instability)
- Related: ADR-035 (carry-forward "hooks crypto dedup" debt; not closed by this ADR)
- Related: ADR-037 (CLI hook platform-adapter architecture — same dual-implementation pattern)
- Closes commit: `161a6bd fix(auth): persisted encryption key — survives macOS hostname changes (v15.7.18)`
- Release: https://github.com/purmemo-ai/purmemo-mcp/releases/tag/v15.7.18
