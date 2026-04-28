# /commit — Persist a commitment-shaped artifact

**Description:** Thin write primitive for ADR-032 commitment-shaped artifacts (PRD, ADR, spec, OKR). Persists the active conversation as a memory tagged `intent='commitment'` with structured commitment fields.

**Usage:** `/commit [type] [key result] [target date]`

> **In most cases, do not invoke `/commit` directly.** It is the underlying write primitive used by `/prd`, `/decide`, and `/spec`. Reach for those workflows instead — they handle research, formatting, and structure, then call this primitive to persist. Use `/commit` directly only when you have an already-drafted commitment artifact in the conversation and just need to record it.

---

## When to invoke directly

- A PRD/ADR/spec is already drafted in the conversation and you want to record it as a commitment without re-running the full `/prd` or `/decide` workflow.
- You are repairing a commitment that should have been saved with `commitment_type` but wasn't.
- You are scripting a one-off backfill from another source.

## Inputs

- **`type`** (required) — one of `PRD`, `ADR`, `spec`, `OKR`, `other`
- **`key_result`** (recommended) — one-sentence concrete deliverable. What is true when this commitment is honored?
- **`target_date`** (optional) — `YYYY-MM-DD`. The date by which the key result is intended to be true. Omit if there's no deadline.

## What gets written

A new memory in `v1_mvp.memories` with:

- `intent = 'commitment'`
- `commitment_type = <type>`
- `key_result = <key_result>`
- `target_date = <target_date>`
- `content` = the commitment artifact text drafted in this conversation (verbatim — do not summarize)
- `title` = a clear descriptive title following the pattern `[Project] - [Subject] - [Type]`

The new memory is queryable via `GET /api/v1/commitments/?type=<type>` and shows up in any `intent='commitment'` filter on the memories table.

## Process

### Step 1 — Confirm the artifact exists in the conversation

If no draft exists yet, do not call `/commit`. Route to `/prd` or `/decide` first.

### Step 2 — Extract the four required fields

Read the conversation and identify:

- **Title** — clear, follows `[Project] - [Subject] - [Type]` pattern.
- **Type** — match one of the canonical five.
- **Key result** — single sentence; ask the user if not unambiguous in the draft.
- **Target date** — if the draft references a deadline, parse it; otherwise leave null.

### Step 3 — POST to the API

```
POST /api/v1/memories/
{
  "title": "<title>",
  "content": "<full commitment artifact text, verbatim>",
  "platform": "claude-code",
  "commitment_type": "<type>",
  "key_result": "<key_result>",
  "target_date": "<YYYY-MM-DD or omit>",
  "tags": ["commitment", "<type-lower>", "<project-name>"]
}
```

The API enforces that `commitment_type` is set whenever `target_date` or `key_result` is present, and forces `intent='commitment'` server-side.

### Step 4 — Confirm to the user

After the API returns, surface the new memory id, commitment type, target date (if any), and the URL pattern for retrieving it (`/api/v1/commitments/<id>`).

## Examples

**Direct invocation — drafted ADR already in conversation:**
```
User: /commit ADR "Phase 1 of /commit ships with markdown-only render and slash-only invocation" 2026-05-26
→ Claude reads the ADR draft from the conversation, POSTs to /api/v1/memories/ with
  commitment_type='ADR', key_result=…, target_date=2026-05-26, returns the new memory id.
```

**Don't do this — use `/decide` instead:**
```
User: /commit ADR "we should use Postgres for X"
→ The user wants a *decision*, not a record of one. Route to /decide which will research,
  document trade-offs, then call /commit at the end.
```

## Why `/commit` is thin (rationale, ADR-032)

- `/prd`, `/decide`, `/spec` are *user-facing authoring workflows*. They produce the document.
- `/commit` is the *persistence primitive*. It writes a memory with the right shape.
- One write path. The same API endpoint that saves any memory also saves commitments — commitment fields are an additive shape, not a parallel system.
- Querying commitments uses standard memory queries (`intent='commitment'`) plus the dedicated `/api/v1/commitments/` route for type/date filters.

## Notes

- `/commit` does not refuse to overwrite. If the same conversation_id has already been saved as a commitment, this acts as an update.
- The `key_result` field on memories has existed since migration 075 (ADR-025). `/commit` reuses it; ADR-032 did not add a new column for it.
- Future expansion: a `/complete-commitment` primitive will mark commitments as honored; for Phase 1 we don't track completion.
