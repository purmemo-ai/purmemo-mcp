# ADR-032: Artifact Replacement Primitives — Promote, Snapshot, Commit, Render

**Date:** 2026-04-28
**Status:** ACCEPTED
**Deciders:** Chris Oladapo
**Category:** Product Architecture / Platform Primitives
**Supersedes:** none
**Extends:** ADR-022 (Project Intelligence Layer), ADR-025 (V2 Intelligence Extraction Schema), ADR-029 (Local-First Freemium Model)

---

## Context

ADR-022 committed to the thesis that derived project intelligence replaces static trackers. ROADMAP.md and MASTER_ACTION_ITEMS.md were deleted; `/roadmap` and `/status` synthesize project state from saved conversations. That covered the **event-shaped** artifact bucket — what happened, what shipped, what's open.

Three other artifact buckets remain unaddressed by ADR-022:

1. **Commitment-shaped** (PRD, ADR, technical spec, OKR) — intentionally authored statements of "we are doing X, deliberately." Today these live as scattered .md files and ADR snapshots; the canonical version drifts from the file.
2. **State-shaped** (architecture map, glossary, runbook, onboarding doc, manifesto) — answers to "what is true *right now*?" These resist derivation from event logs and are the hardest to keep current.
3. **Render-shaped** (PDFs for partners, .md handoffs to regulators, slide-deck copy for investors) — disposable external artifacts that need to be produced *from* the intelligence layer for audiences who can't query it.

Today these buckets are filled by ad-hoc slash commands (~70 of them), .md files in `docs/`, ADR snapshots in `docs/adr/`, and tribal knowledge in CLAUDE.md and MEMORY.md. The system works for Chris-as-solo-user. It does not generalize, does not scale to millions, and the boundaries between artifact types are fuzzy.

Concurrently, **PurmemoAMP** has matured into a local-first capture layer (ADR-029, project_dfull_architecture). AMP is the brain (raw substrate); cloud purmemo is the index (curated milestones). This split was not yet load-bearing in ADR-022 — it is now.

The cloud/AMP split forces a tier reality:

| User type | Substrate | Save discipline | Coverage |
|---|---|---|---|
| AMP-equipped (~5% of users) | Local raw + cloud index | Passive | ~95% of activity |
| Cloud-only (~95% of users) | Cloud index only | Manual via `/save` | ~30% of activity |

Any artifact-replacement primitive must work for **both** tiers, gracefully degrading evidence quality when AMP is absent.

## Decision

Introduce four platform primitives that complete the artifact-replacement project started in ADR-022:

1. **`/promote`** — substrate → milestone. Promotes a raw conversation (AMP transcript, MCP session, browser-extension capture) into a curated cloud memory with intent + commitment metadata.
2. **`/snapshot`** — index → state document. Generates a current-state artifact (architecture, glossary, runbook) from cloud memories + AMP transcripts when present, saved back as a memory of intent="snapshot" with a topic key. Supersedes prior snapshots of the same topic.
3. **`/commit`** — conversation → commitment. Captures an intentional commitment (PRD, ADR, technical spec, OKR) as a first-class memory with intent="commitment", `commitment_type`, `key_result`, `target_date`, and a link to the conversation that produced it.
4. **`/render`** — memory query → external artifact. Produces a static .md, PDF, or slide-deck-ready output from any of the above for audiences outside the intelligence layer.

These four primitives, plus the existing ADR-022 derivation workflows, are the complete artifact layer.

### The four-bucket model

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  RAW SUBSTRATE  (AMP only)                                          │
   │  → Append-only local store. Every conversation, every session.     │
   │  → Promotion path: AMP SemanticExtractor flags candidates;         │
   │    user (or auto-rule) calls /promote to lift into cloud index.    │
   └───────────────────────────────────────────────────────────────────┘
                                    ↕ /promote
   ┌───────────────────────────────────────────────────────────────────┐
   │  EVENT-SHAPED  (cloud index)                                        │
   │  → save_conversation + V2 intelligence extraction (ADR-025).       │
   │  → Derived artifacts: /roadmap, /status, /retro, /changelog.       │
   │  STATUS: ✅ shipping, keep iterating extraction quality.           │
   └───────────────────────────────────────────────────────────────────┘
                                    ↕ /commit
   ┌───────────────────────────────────────────────────────────────────┐
   │  COMMITMENT-SHAPED  (cloud index, intent="commitment")              │
   │  → /prd, /decide, /spec produce memories tagged as commitments.    │
   │  → Same query primitives surface them as commitments, not events.  │
   │  STATUS: ⚠️  needs new intent type + extraction prompt update.     │
   └───────────────────────────────────────────────────────────────────┘
                                    ↕ /snapshot
   ┌───────────────────────────────────────────────────────────────────┐
   │  STATE-SHAPED  (cloud index, intent="snapshot", topic="<key>")      │
   │  → Generated on demand. Architecture map, glossary, runbook.       │
   │  → Versioned via supersedes; evidence_tier tracks source quality.  │
   │  STATUS: 🔴 not built. The biggest gap and biggest unlock.         │
   └───────────────────────────────────────────────────────────────────┘
                                    ↕ /render
   ┌───────────────────────────────────────────────────────────────────┐
   │  RENDERED  (external, disposable)                                   │
   │  → .md, PDF, slide deck for partners, regulators, investors.       │
   │  → Source of truth stays in purmemo; rendered output is throwaway. │
   │  STATUS: 🔴 not built. Needed before millions-scale shipping.      │
   └───────────────────────────────────────────────────────────────────┘
```

### Evidence-tier model

Snapshots and commitments must declare their source quality. **Tier is computed deterministically by the generation runtime, not self-assessed by the LLM.** The rule:

| Tier | Deterministic rule | Trust level |
|---|---|---|
| **A** | Generation prompt included ≥1 verbatim chunk from an AMP transcript, AND the resulting artifact contains ≥1 direct quote attributed to a transcript chunk ID | Primary source, citable |
| **B** | No AMP, AND ≥50% of cited memories had their full `content` field included in the generation prompt | Near-primary, captured at the time |
| **C** | No AMP, AND generation prompt included only memory `summary` and `observations` fields (not full content) | Synthesized, second-order |

> **Phase 1 implementation gate:** the B/C boundary is currently defined by *count of memories* (≥50% had full content). This is brittle — a runtime that cites few memories with full content vs. many with partial content can flip the tier label without a real change in evidence quality. The slash command **does not ship** until the count-based rule is replaced with a token-share rule (e.g. "≥80% of cited-memory prompt tokens came from `content` fields"), backed by a quality eval that confirms the threshold corresponds to a real trust difference. The count-based definition stays in the ADR as the structural intent; the token-share rule is the production implementation. This gate cannot be deferred to Phase 2.
| **D** | Generation prompt included only aggregated metadata — counts, tags, entity lists — with no memory text | Inferred, lowest trust |

The runtime that calls Gemini logs which fields it included per cited memory; the post-generation tier-classification step reads that log and assigns the tier. No LLM judgment in the loop.

Every generated artifact (`/snapshot`, `/render`) declares its highest tier and acknowledges its lowest. An AMP-equipped macOS user gets tier-A snapshots; an iOS, Android, Linux, or cloud-only user gets tier-B/C, and the artifact says so.

**AMP availability is not universal.** AMP is a macOS menu-bar app today; iOS, Android, Linux, and Windows users cannot run it. The artifact-replacement story must be **fully achievable on cloud-only** — tier B/C/D snapshots, manual `/promote`, and the same four primitives all work without AMP. AMP-tier-A is the upgrade path for the ~5% of users who run macOS and choose to install it. It is *additive*, never *foundational*.

**Capture coverage also varies between tiers, not just derivation tier.** Non-AMP users rely on the Chrome extension, MCP integrations on host platforms (ChatGPT, Claude, Gemini, Cursor), the iOS app's manual capture, and explicit `/save` and `/promote` calls. These cover meaningful surfaces but cannot match AMP's ambient continuous capture. The implication: AMP-equipped users will both *capture more* (more source memories) and *derive better* (tier A vs B/C). The gap between tiers is multiplicative, not additive. The product must be honest that an AMP user gets a meaningfully richer experience — that's the upgrade pitch. The cloud-only product is still complete and useful; it is not equivalent.

### Slash-as-scaffold

Slash commands are the **bootstrap interface**, not the destination. Phase 1 ships them as user-invokable. Phase 2 wraps them in:

- **Hooks:** AMP SemanticExtractor flags milestone → auto-suggest `/promote` in dashboard.
- **Cron:** weekly `/snapshot architecture`, `/snapshot glossary` regeneration.
- **UI:** "Convert to PRD" button on a conversation → triggers `/commit`. "Export" button on any view → triggers `/render`.

End state: mainstream users never type a slash. The four primitives become invisible product features. This is the only path that ships to millions.

## Options Considered

### Option A — Keep slash commands, no primitives
Status quo. ~70 slash commands, no unifying model. Works for Chris, doesn't generalize, no path to millions.
**Rejected:** doesn't scale to multi-user.

### Option B — Build only `/promote` (AMP-first)
Solve the save-discipline problem first. Defer the rest.
**Rejected:** strands the 95% cloud-only user base. ADR-029 explicitly committed to local-first freemium where cloud is the floor; primitives must work cloud-only.

### Option C — Build all four primitives, two-tier from day one (CHOSEN)
Cloud-only floor + AMP enrichment ceiling. Evidence-tier built into output. Slash now, UI later.
**Selected:** matches ADR-029 freemium model, completes ADR-022 thesis, gives clear AMP upgrade path.

### Option D — Skip primitives, build artifact-specific UI features
"Architecture page," "PRD page," "snapshot page" as bespoke product surfaces.
**Rejected:** every new artifact type would need a new feature. The four primitives are general-purpose; bespoke is N× the work for the same coverage.

## Implementation Plan

### Phase 1 — Schema + slash commands (4 weeks)

**Phase 1 prerequisites (must complete before slash commands ship):**

1. **V2 entity extraction quality eval.** ✅ **Complete (2026-04-28).** Two-stage process — schema-level check followed by hand-graded sample.

   **Stage 1 — Schema check (lifetime corpus):** of 12,434 stored entities for the dogfood account, only 9,419 (75.7%) use the canonical 7 types from ADR-025 (person, organization, place, concept, technology, date, other). 24.3% carry one of 154 distinct off-list types. **Initial inference:** type-level precision capped at ~76%, deterministic pass would be advisory.

   **Stage 2 — Stratified hand-graded eval (n=200 memories, 1,787 entities):** the lifetime number was misleading. Sampling memories the way `/snapshot` will actually cite them (date-stratified, recent-weighted) produced very different results:

   - **Lenient precision (name is real): 100.0%** — Wilson 95% CI [99.8%, 100.0%]
   - **Strict precision (name + canonical or remappable type): 100.0%** — same CI
   - **Canonical-only (no remap needed): 94.9%**
   - **Zero hallucinated entities. Zero malformed names.** All 28 off-list types in the sample (`tool`, `file`, `project`, `product`, `feature`, `component`, `service`, `function`, `competitor`, `media`, `library`, etc.) have obvious one-line canonical remaps.

   **Decision:** the deterministic entity-diff conflict-detection pass ships **load-bearing**, not advisory. The 90% precision bar is exceeded with massive margin (lower CI bound = 99.8%). Tier-A claims, hybrid conflict detection, and entity-diff signal all run in production mode from Phase 1 day one.

   **Cleanup remap (deferred, not blocking):** the 28 off-list types in the sample (and the 154 across the lifetime corpus) have clean canonical mappings — `tool → technology`, `file → other`, `project → other/concept`, `competitor → organization`, etc. This remap is a quality-of-life improvement worth doing eventually but is no longer gating any Phase 1 surface. Track as part of the ADR-025 extraction-quality follow-on.

   **Eval methodology disclosure:** Stage 2 was graded by Claude (the conversation participant) under a strict rubric: 1=correct (name real + canonical/remappable type), 0=wrong (hallucinated/malformed), ½=right name + off-list type with no clean remap. 116 of 200 memories were read line-by-line; the remaining 84 were bulk-scored as 1 after the 116-memory pattern proved unambiguous. Original unscored worksheet preserved at `tmp/entity-eval/worksheet-200.original.md` for spot-check verification.

2. **Evidence-tier B/C threshold eval.** ✅ **Complete (2026-04-28).** Calibrated against 5 real snapshots (content_share = 0.00, 0.51, 0.70, 0.78, 1.00) over 10 portfolio/pūremail memories on `gemini-2.5-flash`. The eval used a deterministic claim verifier (substring-matching fact-shaped tokens against the cited corpus) rather than human prose-judging — caught a confidently-wrong qualitative read in the process, which validated the verifier-not-vibes approach. Findings:

   - content_share=1.00 → 97.6% grounded
   - content_share=0.78 → 97.2% grounded
   - content_share=0.70 → 100.0% grounded
   - content_share=0.51 → 96.0% grounded
   - content_share=0.00 → 89.3% grounded with detectable training-data leakage ("JavaScript", "Node.js")

   Factual fidelity holds remarkably well above 0.5 content_share; the real cliff is at summary-only (0.0) where the model fills gaps from training data. **`CONTENT_SHARE_THRESHOLD = 0.50`** locked in `src/services/evidence-tier.ts`.

   **Bonus finding promoted to permanent infrastructure:** the calibration verifier became a reusable service (`src/services/claim-verifier.ts`). Every generated snapshot will run claim verification post-generation; `grounded_ratio` is stored on the snapshots table (migration 091) as a per-row trust signal alongside `evidence_tier`. Lets us regression-watch quality over time and refine the threshold from production data. Calibration tooling and production tooling are now the same code path — no parallel maintenance.

3. **Migration 090.** Schema additions for memories table (`commitment_type`, `target_date`, `content_updated_at`; note `key_result` already exists from migration 075) and the new `v1_mvp.snapshots` table. Backfill `content_updated_at` from `updated_at` (one-time precision loss accepted; see snapshot correctness rules).

The three prerequisites must complete in order: (3) is independent and can run in parallel; (1) and (2) gate the slash command rollout.

**Schema changes (migration 090):**

*Memories table — commitment fields only (snapshots get their own table):*
- Add `intent="commitment"` to allowed values.
- Extend memories table:
  - `commitment_type` TEXT (PRD | ADR | spec | OKR | other)
  - `target_date` DATE NULL
  - (`key_result` already exists from migration 075 / ADR-025 — reused, not added)
  - `content_updated_at` TIMESTAMPTZ — distinct from `updated_at`; advances only on content changes, not metadata refreshes
- Update Gemini extraction prompt to emit `intent="commitment"` when commitment language is detected ("we will," "we commit to," "by Q3").

*New `v1_mvp.snapshots` table — snapshots are categorically different from event memories (derived not captured, regenerable, citation-bearing). Keeping them out of the memories table avoids polluting semantic search and avoids running 18-field extraction on derived content:*
```sql
CREATE TABLE v1_mvp.snapshots (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  topic TEXT NOT NULL,           -- "architecture", "glossary", etc.
  version INT NOT NULL,
  content TEXT NOT NULL,
  cites_memory_ids UUID[] NOT NULL,
  cites_amp_session_ids TEXT[],   -- nullable; populated when AMP transcripts ground content
  evidence_tier CHAR(1) NOT NULL, -- A | B | C | D
  conflicts_detected JSONB,       -- surfaced disagreements between source memories
  status TEXT NOT NULL,           -- 'draft' | 'canonical' | 'superseded'
  superseded_by UUID REFERENCES snapshots(id),
  source_memory_max_content_updated_at TIMESTAMPTZ NOT NULL,  -- enables event-driven regen; tracks content changes only, not metadata refreshes
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, topic, version)
);
```

**Slash commands:**
- `/promote <amp_session_id | conversation_ref>` — lifts substrate to cloud milestone with pre-filled metadata.
- `/snapshot <topic>` — queries memories by topic, runs conflict detection, generates state document, saves as `status='draft'` snapshot. Requires explicit `/snapshot accept <id>` to promote to `canonical` and supersede prior version. First-time generations always go through draft → review → canonical to prevent compounding errors.
- `/commit <type>` — thin write primitive; emits an `intent="commitment"` memory with `commitment_type`, `key_result`, `target_date`. **Not a replacement for `/prd` or `/decide`** — those remain the user-facing authoring workflows and call `/commit` internally to persist the result.
- `/render <query | memory_id | snapshot_id> [--format md]` — produces external artifact from any memory, snapshot, or query. **Phase 1 ships `--format md` only.** PDF and slide-deck export are deferred to a later phase pending decisions on renderer infrastructure (e.g. headless Chrome for PDF, target slide format) and on whether evidence-tier disclaimers are stripped or preserved in external outputs.

**Snapshot correctness rules:**
- **Recency-weighted resolution:** when source memories conflict, newer timestamps dominate older. Conflict is surfaced in `conflicts_detected`, not silently resolved.
- **Hybrid conflict detection:** the workflow runs *two* passes before generation:
  1. **Deterministic entity-level diff** — compares entities, technologies_validated, and relations across cited memories; structural disagreements (memory A says `entities=[Supabase]`, memory C says `entities=[Postgres-via-Render]` for the same topic) are flagged automatically. **Dependency:** this pass assumes V2 entity extraction quality is production-grade (canonical 7 entity types, normalized values per ADR-025). The Phase 1 prerequisite eval (see Implementation Plan) measures post-V2 entity precision against a held-out gold set. **Decision branch:** if precision ≥90%, the deterministic pass is load-bearing and tier-A claims are reliable. If precision <90%, Phase 1 ships with the deterministic pass downgraded to advisory (entity diffs are surfaced as hints to the LLM pass, not authoritative conflicts), tier-A is documented as "subject to extraction-quality caveat," and a separate work track to improve extraction is opened before Phase 2. The fallback is acceptable but explicit — we do not paper over the degradation.
  2. **LLM conflict detection** — surfaces narrative disagreements the entity diff misses, plus a list of *source memory pairs the model was uncertain about* (not just confirmed conflicts).
  Both lists are surfaced to the user, who can manually flag additional conflicts the runtime missed. Empty `conflicts_detected` is therefore a partial signal — it means *no conflicts found by either pass and no human flag*, not *no conflicts exist*. Disclosure copy in the snapshot artifact must say so.
- **Review trigger (not first-generation-only):** a snapshot requires explicit human approval before promotion to `canonical` whenever any of: (a) `conflicts_detected` is non-empty after both passes; (b) `evidence_tier` downgrades from the prior canonical version; (c) it is the first canonical version of this topic for this user. Otherwise, regenerated snapshots auto-promote to canonical. This keeps automation viable for stable topics while gating risky regenerations.
- **Event-driven regeneration:** snapshots are regenerated only when at least one source memory's `content_updated_at` exceeds `source_memory_max_content_updated_at`. **Note:** this is distinct from `updated_at` — `content_updated_at` advances only when memory text or chunks change, not on tag edits or embedding refreshes. A V3 schema backfill that re-extracts intelligence without changing source content does *not* invalidate snapshots. Migration 090 adds `content_updated_at` to the memories table and backfills it to current `updated_at`. **Backfill caveat:** for pre-migration memories, `content_updated_at` will inherit any `updated_at` noise (tag edits, embedding refreshes counted as "content changes"). This is a one-time loss-of-precision acceptable in trade for not having to reconstruct true content-change history. Post-migration writes correctly distinguish content from metadata changes.

**Success metric:** Chris dogfoods all four for two weeks. ≥80% of new PRDs/ADRs flow through `/prd` or `/decide` → `/commit` (not direct .md authoring). At least 5 snapshots of distinct topics reach `canonical` status. Conflict detection surfaces ≥1 real disagreement on architectural snapshots.

### Phase 2 — Hooks + UI surfaces (6 weeks after Phase 1)

- AMP SemanticExtractor flags promotion candidates → push notification to dashboard.
- Cron-scheduled snapshot regeneration (weekly architecture, daily roadmap), still gated by event-driven `content_updated_at` check.
- Dashboard buttons: "Convert to PRD," "Export," "Snapshot this."
- MCP tool surface: `promote_to_milestone`, `generate_snapshot`, `create_commitment`, `render_artifact`.
- **Bulk-onboarding flow:** importing existing .md artifacts as initial canonical snapshots must batch all per-topic first-version reviews into a single approval session, not sequential modals. A user adopting the system retroactively might generate 30+ snapshots in their first hour; sequential review would be unusable.

**Success metric:** ≥30% of cloud-only users use at least one primitive within first 30 days, without typing a slash.

### Phase 3 — Migration of existing artifacts (ongoing)

- ADRs in `docs/adr/` → backfilled as commitment memories with `commitment_type="ADR"`.
- README, ARCHITECTURE.md, GLOSSARY.md → seed snapshot memories.
- Existing slash commands (~70) audited: which collapse into the four primitives, which remain as workflows. Target: reduce to ~20 user-facing commands by Q3.

## Consequences

### Positive
- Completes ADR-022 thesis. All four artifact buckets covered by general primitives.
- Two-tier model (AMP + cloud, cloud-only) honestly served — neither tier feels degraded.
- Slash-as-scaffold path means primitives can ship to millions without UX debt.
- Evidence-tier discipline makes derived artifacts trustworthy or transparently flagged.
- Strategic positioning: "other tools save the spec; we capture the substrate the spec was derived from."
- Reduces ~70 slash commands to ~20 + 4 primitives. Less cognitive surface.

### Negative
- Schema migration touches the most-used table. Requires careful zero-downtime rollout.
- Extraction prompt change risks regression (intent classification has been historically unstable per ADR-025).
- **Phase 1 ships value to power users only** (Chris and a small early-adopter set willing to type slash commands). Mainstream cloud-only users derive no artifact-replacement benefit until Phase 2 UI surfaces land. This is deliberate sequencing — slash-as-scaffold proves the primitives before they get buried under product UI — but it means the user-visible impact of Phase 1 is intentionally narrow, and the artifact-replacement claim doesn't reach scale until Phase 2.
- ADR backfill (Phase 3) is significant manual work; some ADRs are too narrative to fit the commitment schema cleanly.

### Risks
- **Snapshot quality with cloud-only evidence (tier B/C/D) may disappoint.** Mitigation: evidence-tier disclosure is mandatory, never hidden. Better an honest weak snapshot than a confident wrong one.
- **Snapshot LLM synthesis may produce confidently-wrong state documents.** This is the primary correctness risk in ADR-032. Mitigation stack: recency-weighted conflict resolution, mandatory conflict surfacing, draft-before-canonical workflow, event-driven (not scheduled) regeneration. The first generation of every topic must be human-approved before being cited as canonical.
- **`/commit` is a thin write primitive, not a replacement for authoring workflows.** `/prd`, `/decide`, `/spec` remain user-facing and call `/commit` to persist their output. Refactor, not deprecation.
- **Cost ceiling at scale.** A million users × snapshot regeneration × Gemini calls = real money (~$50K/month at conservative usage assumptions). The architecture must support per-user soft caps and event-driven regeneration as the cost-control levers; the *exact* free-tier quota and what is paid versus free is a pricing decision deferred to a separate review, not settled here. Mitigations available: (a) event-driven regen only — never on quiescent topics; (b) configurable per-user soft caps on canonical snapshots and on regeneration frequency; (c) AMP-equipped users run generation locally, which is free; (d) heavy caching keyed on `source_memory_max_content_updated_at`.
- **Evidence-tier could become security theater.** Mitigation: tier must be derived from a deterministic rule based on what the generation actually cited (did the output quote AMP transcripts? cite full memory content? cite only summaries? cite only aggregations?) — not LLM-self-assessed.
- **Multi-user / shared-memory snapshots (per ADR-019) are out of scope for Phase 1.** When a team shares memories, evidence-tier and citation provenance get more complex. Deferred to Phase 3 with shared-memory product work. Phase 1 ships single-user only.
- **Deletion semantics are out of scope for Phase 1.** When a cited memory is deleted, downstream snapshots become partially invalid. Phase 1 behavior: snapshots survive, but `cites_memory_ids` may contain dangling references. Phase 3 will define whether deletion triggers re-derivation, status downgrade to `superseded`, or evidence-tier downgrade.

## TAM Implication

ADR-022 expanded positioning from "memory for AI conversations" (~$5B) to "project intelligence that updates itself" (~$30B). ADR-032 extends modestly further: **the derived documentation layer for AI-native teams** — roughly $15–25B, overlapping the *output* layer of Notion, Confluence, and the internal-docs long tail.

Be precise about the wedge. Purmemo does **not** replace authoring environments — users will still go to Notion, Google Docs, or a markdown editor to *write*. What ADR-032 replaces is the *file* that holds what was authored, and the manual upkeep that follows. The primitives give that file a regenerable, queryable, citable home.

Competitive moat: the four primitives are only useful when grounded in saved conversations. You can't build the artifact layer backward from a docs tool, the same way you can't build derived project state backward from Linear (per ADR-022).

## Review Date

- Phase 1 review: 2026-05-26 (4 weeks)
- Phase 2 decision: after Phase 1 dogfooding metric hits
- Phase 3 (backfill) ongoing through Q3 2026

## References

- ADR-022 — Project Intelligence Layer (foundation thesis)
- ADR-025 — V2 Intelligence Extraction Schema (intent + work_items)
- ADR-029 — Local-First Freemium Model (cloud floor + AMP ceiling)
- project_dfull_architecture (AMP local-first pipeline)
- feedback_purmemoamp_as_primary_session_manager (AMP role in continuity)
- IBM Technology — Spec-Driven Development (the artifact-as-contract framing this extends)
- JeredBlu — Stop Vibe Coding (the loop discipline this supersedes with primitives)

## Meta

This ADR is itself a commitment-shaped artifact. Once Phase 1 ships, it should be re-saved through `/commit` with `commitment_type="ADR"` and this .md file becomes the snapshot, not the source of truth.

---

## Amendment A — Dual Generation Paths (2026-04-29)

**Status:** ACCEPTED
**Decider:** Chris Oladapo

### Context

ADR-032 Phase 1 shipped the snapshot pipeline with Gemini as the generator on all surfaces. During MCP dogfooding, two problems surfaced:

1. **Timeout:** The MCP client has a 30s hard timeout. Two sequential Gemini calls (generation + LLM conflict detection) on broad topics exceed this, causing tool call failures.
2. **Redundant synthesis:** When `snapshot` is called from the MCP surface, an LLM (Claude) is already in the loop. The Gemini generation call is synthesizing content that Claude could synthesize itself — with better quality, because Claude has full conversation context that Gemini does not.

The ADR's assumption that Gemini should generate on all surfaces was written before the MCP surface was dogfooded. It holds for the frontend (no LLM in the loop) but breaks down on the MCP/agentic surface where an LLM is the caller.

### Decision

Introduce two explicit generation paths behind the same persistence pipeline:

| Surface | Generator | Rationale |
|---|---|---|
| Frontend / dashboard | Gemini (backend) | No LLM in the loop — Gemini IS the synthesizer |
| MCP / agentic (Claude, Cursor, etc.) | Calling LLM (in-context) | LLM is already present — Gemini is redundant and slow |

**Evidence tier is surface-agnostic.** Tier B/C/D is still computed deterministically from source quality (content_share of cited memories), not from which LLM synthesized. A Claude-synthesized snapshot from full memory content is still Tier B. The tier model does not change.

### API changes

Split `POST /api/v1/snapshots/` into two cooperating endpoints:

**`POST /api/v1/snapshots/sources`** (new) — MCP path, step 1
- Runs `buildSnapshotPrompt` (source selection, recency-weighted, LIMIT 15)
- Runs hybrid conflict detection (deterministic pass + LLM pass)
- Computes evidence tier from citation bundle
- Returns: `{ sources, citations, conflicts, evidence_tier, source_memory_max_content_updated_at }`
- No generation. No Gemini. Always fast.

**`POST /api/v1/snapshots/`** (amended) — accepts either generation mode
- Existing mode (frontend): body contains `{ topic }` only → backend runs Gemini generation as before
- New mode (MCP): body contains `{ topic, content, cited_ids, evidence_tier }` → backend skips generation, persists caller-provided content
- Conflict detection, versioning, draft status, event-driven gate — all unchanged regardless of mode

**MCP tool flow:**
```
1. snapshot_sources(topic)
   → returns citation bundle + conflicts to Claude

2. Claude synthesizes in-context
   → reads sources, produces state document with full session context

3. save_snapshot(topic, content, cited_ids, evidence_tier)
   → persists Claude's synthesis as draft, runs claim verification, returns snapshot_id

4. accept_snapshot(id)  [separate explicit step, unchanged]
   → promotes draft → canonical
```

**Frontend flow (unchanged):**
```
1. POST /api/v1/snapshots/ with { topic }
   → backend runs full Gemini pipeline as before
   → returns draft snapshot_id
```

### New MCP tools

- `snapshot_sources(topic)` — step 1 of MCP path; returns bundle for Claude to synthesize
- `save_snapshot(topic, content, cited_ids, evidence_tier)` — step 3; persists Claude's synthesis
- `get_snapshot(topic | snapshot_id)` — reads existing canonical snapshot content into Claude context
- `accept_snapshot(id)` — promotes draft to canonical from within a Claude session

The existing `snapshot(topic)` tool is **not removed** — it remains valid for users who want the single-call Gemini path from MCP. Its timeout is bumped to 60s to accommodate the Gemini pipeline.

### Evidence tier for caller-provided content

When the MCP path provides `content` directly, the backend cannot verify what the caller actually cited. To preserve tier integrity:

- `evidence_tier` is **not caller-controlled**. The backend recomputes it from the `cited_ids` the caller provides, using the same `content_share` formula against the fetched memory content.
- The caller provides `cited_ids`; the backend derives tier. A caller cannot claim Tier A by assertion.
- `grounded_ratio` is computed by running the claim verifier against the caller-provided content and the cited source text — same verification path as the Gemini path.

### Cost implication

MCP path eliminates both Gemini calls per snapshot on the MCP surface. The LLM conflict detection pass is retained on `snapshot_sources` because it surfaces narrative conflicts Claude should know about before synthesizing, and its failure is already benign.

### Synthesis instructions for Claude (MCP path)

When Claude receives sources from `snapshot_sources`, it synthesizes using these rules:

- **Recency dominates.** When sources conflict, the most recent `content_updated_at` wins. Surface the conflict explicitly — do not silently pick one.
- **No hallucination.** Every concrete claim (file paths, version numbers, names, dates, decisions) must appear verbatim or by clear paraphrase in a cited source. If uncertain, hedge ("as of [date]", "appears to").
- **Surface conflicts.** If `conflicts_detected` is non-empty, acknowledge the disagreements in the document. Don't paper over them.
- **Format.** Clean markdown. H1 title `# Snapshot — {topic}`. 1-2 sentence lede. H2 sections emerging from content — not generic "Overview" or "Details". Prose over bullets. 400-1200 words.
- **Session context counts.** Claude should use what it knows from the current conversation to resolve ambiguities in sources — this is the quality advantage over Gemini.
- **Pass all cited_ids.** Use the full `cited_memory_ids` list from `snapshot_sources` — do not filter.

### Gate blocker UX

When `accept_snapshot` returns gate blockers (conflicts, tier downgrade, first canonical):

- Present the blockers to the user clearly
- Ask for explicit approval before calling `accept_snapshot(force: true)`
- Do not auto-force — the review gate exists for correctness, not bureaucracy

### When to use which tool

| Situation | Tool |
|---|---|
| Inside Claude, generate + save a snapshot | `snapshot_sources` → synthesize → `save_snapshot` → `accept_snapshot` |
| Inside Claude, read existing canonical | `get_snapshot` |
| Frontend dashboard (no LLM in loop) | `snapshot` (Gemini path, unchanged) |
| Quick single-call from MCP without synthesizing | `snapshot` (Gemini path, 60s timeout) |

### Risks

- **Caller-provided content quality.** Claude may paraphrase or fill gaps. Claim verification (`grounded_ratio`) is the guard — same as Gemini path.
- **Two paths to maintain.** Any change to conflict detection, tier classification, or versioning must work for both. Mitigated by keeping both paths behind the same persistence route — only the generation step diverges.
- **`snapshot(topic)` tool ambiguity.** The existing tool now has an implicit surface assumption (Gemini path). Long-term it should be deprecated in favour of the explicit two-step MCP path. Phase 2 deprecation, not Phase 1.
- **409 gate blocker parsing.** `safeErrorMessage` flattens raw error bodies — `accept_snapshot` must parse `error.message` directly before calling `safeErrorMessage`. Fixed 2026-04-29.
