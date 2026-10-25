# ADR-040: Per-call account selection over signed-in profiles

Date: 2026-10-25. Status: accepted. Supersedes the "parked" status of the 2026-08-05 multi-account design thread.

## Context
One person can have several purmemo accounts signed in on one machine (personal, an employer's work account, and
others later). Until now the server resolved one account at startup (PURMEMO_PROFILE, else the active pointer) and the
only way to reach a second account was to register the server twice. That multiplies the tool list per account,
turns the account choice into a tool-name choice, and pushes programs that need a second account into reading
purmemo's encrypted token files themselves. Work content must never land in a personal account, and accounts must
stay separable when a job ends.

## Decision
Judged three-way debate (debate3-1792966568: OpenAI, Gemini and Claude sides, fresh blind judge) chose a hardened
version of "purmemo owns account-bound operations":
- **Selector, not identity.** Account-aware tools take an optional `account`: one of the profiles signed in on this
  machine (`src/auth/accounts.ts`). Anything else is refused before any network call. Omitted = the default account,
  so single-account behaviour is unchanged and the tool list is identical with one account.
- **Bound per call.** A non-default account runs inside `runWithApiKey` (AsyncLocalStorage) for that call only. The
  active pointer and process-wide key are never changed. The recall ordinal cache is keyed by the effective key, so it
  is per account automatically.
- **Side channels respect the scope.** The shadow mirror files under one fixed identity, so it is skipped for any
  non-default account (`isAlternateAccountScope()`); next read routing authenticates by the bound key and needs no change.
- **Moves.** `transfer_memory` calls the API's atomic `POST /memories/:id/transfer` as the source with the destination
  account's credential. It refuses ordinals, unknown accounts, same-account moves, and multi-part documents (moving
  one chunk of a document would split it).
- **Programs.** `purmemo-ops` exposes the same boundary as JSON commands and requires an explicit account on every
  call: automated jobs state their scope.
- **Audit.** Every non-default call and every move appends a content-free, key-free line to `~/.purmemo/account-audit.jsonl`.
- **Local only.** Remote (hosted) mode never lists or accepts it; its profiles belong to the host.

## Consequences
- Hooks and auto-capture stay pinned to the active pointer. A machine whose sessions mix work and personal content
  still needs the person to choose the active account there (the "confused deputy" risk the judge named).
- Removing a local profile does not revoke its key on the server; handing over a job account should also revoke the
  key from the account side. Follow-up.
- Multi-part document moves are a follow-up (move every part in one server transaction).
- Policy (which life area belongs to which account) is the caller's job, not purmemo's.
