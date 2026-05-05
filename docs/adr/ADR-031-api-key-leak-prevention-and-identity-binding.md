# ADR-031: CLI Device-Authorization Flow & Identity Binding

- **Status**: Proposed — P0, production hotfix required
- **Date**: 2026-04-23
- **Deciders**: chris@purmemo.ai
- **Severity**: Cross-account takeover. A long-lived API key can be silently minted against the wrong user's account via a stale browser session. All live users affected; no client compromise required.
- **Triggering Incident**: A new user (`jodeleigh.nembhard@gmail.com`) ran `npx purmemo-mcp@latest init` on her own Mac, completed what she believed was Google OAuth, and began using the MCP. Every memory she saved was written to `chris@purmemo.ai`'s account. Direct forensic investigation confirmed: her `~/.purmemo/auth.json` was created at the moment of `init`, her shell had no `PURMEMO_API_KEY` env var, no `.mcp.json` or dotfile on her machine contained the key, and no OAuth token was issued to either user in `oauth_tokens`. The leaked artifact was a freshly-minted API key (`sk-purmemo-a83e8a601…`) bound to Chris's user_id, returned by the CLI-connect flow.

## Root Cause

The CLI connect page (`v1-mvp/frontend/app/cli-connect/page.tsx:42-64`) auto-completes the CLI device session using *whatever* API key is present in browser `localStorage`, with no identity confirmation shown to the human:

```tsx
useEffect(() => {
  if (!sessionId) { setPageState("invalid"); return; }
  if (urlToken) { /* ...OAuth return path... */ return; }

  const apiKey = getApiKey();          // reads localStorage
  if (apiKey) {
    completeSession(apiKey);           // silent auto-complete
  } else {
    setPageState("login");
  }
}, [sessionId]);
```

`completeSession` then `POST`s `/api/v1/auth/cli/complete` with the stored Bearer token. The backend (`purmemo-api/src/routes/auth.ts:350-392`) accepts any authenticated caller, mints a new 365-day API key for *that* caller, and stores it in the in-memory `cliSessions` map. The CLI polls `/cli/poll/:sessionId`, receives the API key, and writes it to `~/.purmemo/auth.json`.

**Trust chain:** Browser localStorage → backend `auth` middleware → new API key for whoever owns that localStorage token → CLI on a completely different person's machine.

**What's missing:**
1. **No human confirmation** that the browser session owner is the same person who invoked the CLI. The page never asks "Connect CLI to `chris@purmemo.ai`? [Confirm]."
2. **No cryptographic binding** between the CLI invocation and the browser. The session_id is generated server-side and handed to both parties over untrusted channels; anyone holding a valid API key in the same browser can complete any active session_id.
3. **No user-facing pairing code**. Device authorization flows in every comparable product (GitHub CLI, Google TV, Vercel CLI, Stripe CLI) require the CLI to display a short code that the human must type into the browser. We skip this entirely.
4. **No account-owner notification.** A new long-lived API key is minted with no email to the account owner, no entry in a user-visible audit log, and no rate limit.

**How stale browser sessions arise in normal use**, none of which require client compromise:
- Support / demo / screen-share sessions where Chris signed into `app.purmemo.ai` on a user's machine.
- Shared household machines.
- Browser profile sync (Chrome profile, Arc sync, Safari iCloud tabs) carrying `purmemo_api_key` localStorage across devices.
- A user visiting `app.purmemo.ai` on a kiosk or colleague's laptop.

In each case, the next person to run `npx purmemo-mcp init` in a context that opens the same browser will silently receive an API key for the prior session's owner. The `init`ing user sees "CLI Connected!" and has no signal that the connected account is not theirs.

## Threat Model (what we should have had)

The CLI install flow must be safe in all of these adversarial scenarios, which a live multi-user product must handle by default:

1. A user installs on their own machine but shares the browser with someone who's signed into purmemo.
2. A user's browser profile syncs `localStorage` from another device where a different person was signed in.
3. Two users install on the same machine at different times.
4. Support staff sign into a customer's machine, forget to sign out, customer runs `init`.
5. A user runs `init` on a machine where they're not signed into purmemo yet, opens the page, signs in as themselves — must succeed correctly.
6. An attacker with browser access but *not* system access to a victim's machine should not be able to mint arbitrary keys for the victim.

The current implementation fails 1, 2, 3, 4, and 6. It only handles 5 correctly — the "happy path where the only person who has ever used this browser is the installer."

## Decision

Rebuild the CLI install as a proper **OAuth 2.0 Device Authorization Grant** (RFC 8628), matching the pattern used by `gh auth login`, `stripe login`, `vercel login`, and Google TV. Ship in three phases; phase 1 is a **P0 hotfix** that closes the vulnerability.

### Phase 1 — Hotfix (ship immediately; no migration needed)

**Goal**: eliminate silent auto-complete. The flow should always ask a human to confirm.

**Frontend changes** (`v1-mvp/frontend/app/cli-connect/page.tsx`):
- Remove the auto-complete branch at line 57–62. Never call `completeSession` on page load.
- On load, if `getApiKey()` returns a key: fetch `/api/v1/auth/me` with it, then render an explicit confirmation card:
  > **Connect CLI to pūrmemo?**
  > You're signed in as **chris@purmemo.ai**. This CLI session will be linked to this account.
  > *Pairing code displayed in your terminal:* **`XTRF-9K2M`**
  > Type the code to confirm → [ _ _ _ _ - _ _ _ _ ]
  > [Confirm & Connect] [Sign in as a different account]
- The "sign in as different account" link calls `logout()` (clears localStorage) and sends the user to login.
- The `urlToken` / social-OAuth return path must also show the confirmation card — no auto-complete on return from Google/GitHub OAuth either.

**CLI changes** (`purmemo-mcp/src/setup.ts`):
- On `POST /api/v1/auth/cli/request`, the server now returns `{ session_id, pairing_code, expires_in }`. The CLI prints the pairing code prominently:
  > `Opening https://app.purmemo.ai/cli-connect?session=…`
  > `Your pairing code: XTRF-9K2M`
  > `When the browser asks, verify this code matches.`
- On completion, the CLI fetches `/auth/me` once with the returned API key and prints `Connected as <email>. Account: <tier>.` — same identity echo the ADR originally proposed, now unconditional.

**Backend changes** (`purmemo-api/src/routes/auth.ts`):
- `POST /cli/request` generates a 8-char pairing code (e.g. `XTRF-9K2M`, base32, excluding ambiguous chars) alongside `session_id`. Stores both in `cliSessions`.
- `POST /cli/complete` (new required body field: `pairing_code`): verifies the pairing code matches the one issued for this `session_id`. Rejects with 400 on mismatch. Rate-limit to 5 attempts per `session_id` before the session is invalidated.
- On success: generate API key with `device_label = "CLI (<platform>, <hostname-hash>)"` where the CLI passes `platform` and a non-identifying machine-id hash in the request. Insert a row into a new `api_key_events` audit log. Send an email to the account owner: *"A new CLI was connected to your pūrmemo account. If this wasn't you, revoke the key here."*
- Remove the current "any authenticated user → mint key for self" path entirely; the pairing code is mandatory.

**Acceptance tests** (must all pass before merge, all new tests):
- Browser with localStorage key + no pairing code entered → no key issued.
- Browser with localStorage key + wrong pairing code → rejected, session invalidated.
- Browser with localStorage key + correct pairing code → key issued, audit row written, email sent.
- Browser with localStorage key for user A + pairing code for user A's session, but the CLI was invoked by user B (different `session_id`) → no key crossover possible (pairing code bound to session_id).
- Two concurrent `init` flows from the same browser → each needs its own pairing code.
- 6 wrong pairing attempts → session invalidated, CLI sees a clear error.

**Why this closes the incident class:** the attacker/accident path requires (a) stale browser session *and* (b) the ability to read the pairing code from the victim's terminal. The pairing code is only ever displayed to the person at the CLI — if they see a confirmation page for the wrong email and cancel, no key is minted. If they proceed blind and type the code anyway, they at minimum see *whose account* they're connecting before committing.

### Phase 2 — Hardening (within 2 weeks)

- Replace the in-memory `cliSessions: Map` with a database table (`cli_sessions`: `session_id`, `pairing_code_hash`, `user_id` (nullable until complete), `status`, `device_label`, `created_at`, `completed_at`, `ip`, `user_agent`). Current `Map`-based storage does not survive backend restarts and cannot be audited.
- Add a **Connected Devices** page to the dashboard (`/settings/devices`): list every CLI / MCP install with device label, last-used, last-IP, "Revoke" button. This is the durable user-facing surface that turns "my key got used somewhere weird" from a support ticket into a self-serve action.
- On every API-key call, record `last_used_at`, `last_used_ip`, `last_used_user_agent` into `api_keys` (requires migration). Drives the devices page.
- Email alert when a key is first used from a new IP country or ASN.

### Phase 3 — Defense-in-depth (next quarter)

- Short-lived access tokens + refresh tokens for MCP calls, replacing the 365-day API key as the primary auth for CLI installs. Keep long-lived API keys as an advanced/explicit option for CI use, gated behind a separate dashboard flow.
- Machine-identity fingerprint sent as `X-Purmemo-Client-Identity`. First identity to present a key is bound; subsequent different identities get logged and the owner alerted (phase 3a) or blocked until they confirm (phase 3b).
- **⚠️ Fingerprint primitive REVISED 2026-05-04 (see ADR-039):** the original proposal `SHA-256(hostname + machine-id + os_user)` is unsafe because `os.hostname()` flips on macOS with VPN toggles, Wi-Fi switches, and sleep/wake. A hostname-based fingerprint would produce constant false-positive "different identity" flags for users on laptops. Phase 3 must use a hardware-stable primitive (`IOPlatformUUID` on macOS, `/etc/machine-id` on Linux, machine GUID on Windows) OR reuse the persisted random key from ADR-039 (`~/.purmemo/.encryption-key`) as the client identity token. The latter ties server-side fingerprinting to the same artifact that decrypts local tokens — same trust boundary, same loss/copy semantics.
- Require re-auth for any write operation that crosses a new-device boundary.

## Consequences

**Positive**
- The incident class is closed by Phase 1 alone. Silent cross-account key minting is no longer possible.
- The new flow matches user expectations — every developer who's used `gh auth login` or `stripe login` already knows to verify a pairing code.
- Phase 2 gives users visibility into what's connected to their account without requiring a support ticket.
- Audit log + email alert means that even if a pairing-code-bypass bug ships in the future, the account owner has 24-hour notice rather than discovering it months later.

**Negative**
- Users installing the CLI now do slightly more work: read a code, type it. Mitigation: the code is shown auto-copied in the terminal and pre-filled on the confirmation page where possible; it's still fewer steps than `gh auth login`.
- Existing users with keys already issued are not retroactively protected. The migration path is: Phase 2 ships the devices page with one-click revocation; we send an email blast to every user with >0 API keys asking them to audit.

**What still doesn't work after this ADR**
- A user who reads the pairing code, sees "Connect to chris@purmemo.ai," *and clicks confirm anyway* will still mint a key for the wrong account. That's a user-error case, not a product vulnerability — the same way confirming a phishing site is a user-error case. The product has done its job by surfacing the identity.
- A malicious insider with screen-share to a victim's terminal + browser access to purmemo is not fully protected. That's the Phase 3 fingerprint work.
- Remote (claude.ai-hosted) MCP OAuth is out of scope here; it has a different failure mode (claude.ai identity, not purmemo identity). Separate ADR.

## Immediate Actions (before the ADR lands)

1. **Revoke `sk-purmemo-a83e8a601…`** (the key issued to Chris during the incident, now present on Jode-Leigh's machine).
2. **Delete `~/.purmemo/auth.json` on Jode-Leigh's Mac**, have her re-run `npx purmemo-mcp setup` — but only after Phase 1 ships, or the same bug will recur with her own credentials.
3. **Query `v1_mvp.api_keys`** for any key created via the CLI flow in the past 90 days. Cross-reference with `v1_mvp.users.last_login_at` and dashboard session IPs. Any key whose creation pattern doesn't match a legitimate install should be flagged and the owner emailed.
4. **Add a banner to `/cli-connect`** in the live site today: "Do not proceed if the account shown is not yours." Bandaid until Phase 1 ships; better than nothing.

## Files Touched (Phase 1)

- `v1-mvp/frontend/app/cli-connect/page.tsx` — remove auto-complete; add pairing-code confirmation UI
- `purmemo-frontend/app/cli-connect/page.tsx` — same change (there are two copies of this page; consolidate separately)
- `purmemo-mcp/src/setup.ts` — display pairing code; pass it to `/cli/complete`
- `purmemo-api/src/routes/auth.ts` — generate & verify pairing code; rate-limit; audit log; email
- `purmemo-api/src/db/schema.ts` — new `api_key_events` table; additional columns on `cli_sessions` when phase 2 ships
- `purmemo-api/src/__tests__/cli-auth.test.ts` — new, covering every acceptance test above
- Migration: add `api_key_events` table, add `device_label`, `last_used_ip`, `last_used_user_agent` columns to `api_keys`

## Alternatives Considered

- **Just show the email on the page, keep auto-complete**: rejected. The incident shows users miss or misinterpret confirmation text that doesn't require interaction.
- **PKCE with the CLI as a public client**: correct long-term direction but requires significant redesign. Phase 3 territory.
- **Disable CLI install entirely until fix ships**: considered. Rejected because it breaks every new signup for N days. The banner-plus-fast-hotfix is the faster ship.
- **Rotate every live API key and force reconnect**: too disruptive; most keys are legitimate. Phase 2 devices page is the right tool for cleanup.

## Related

- Incident transcript (Jode-Leigh, 2026-04-23) — memory `d3bb22cd-b4d6-46eb-870c-5fae0e66fdca` (since reassigned to user `4c03d324…`)
- `v1_mvp.memories.memory_events` trigger (migration 067) — does *not* help here; the write was server-valid. Auth is the layer that failed.
- ADR-017 — MCP distribution parity (unchanged by this ADR)
- RFC 8628 — OAuth 2.0 Device Authorization Grant (canonical spec to implement against)
- `gh auth login` source for reference UX: https://github.com/cli/cli/blob/trunk/pkg/cmd/auth/shared/login_flow.go
