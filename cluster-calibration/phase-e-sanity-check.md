# Phase E — Sanity Check on Other Users

**Date:** 2026-04-29
**Privacy:** Only project_name strings + counts read. NO titles, NO content, NO memory bodies inspected. The two users whose memories Claude saw (project_name strings only): Lawrence (213 memories), Jasmin (104 memories).

## Scope rationale

Phase A-D calibrated against chris@purmemo.ai (3,152 memories, 83% of platform). Phase E confirms the migration doesn't overfit to my data and behaves correctly for users whose corpora I never read.

The other two users with substantial data: **Lawrence (213 memories, 8 distinct projects, 200 orphans)** and **Jasmin (104 memories, 5 distinct projects, 98 orphans)**. Combined they're ~91% of the remaining platform memories.

## Test 1 — Alias normalization (their `project_name` values vs. our alias map)

| User | raw_project_name | count | After Phase D | Change type | Verdict |
|---|---|---:|---|---|---|
| **Jasmin** | `Pūrmemo` | 2 | `purmemo` | normalized | ✓ correct merge |
| **Jasmin** | `ChatGPT Images` | 1 | (unknown — pass through) | unchanged | ✓ preserved |
| **Jasmin** | `Mia Secret LA Pop-Up` | 1 | (unknown — pass through) | unchanged | ✓ preserved |
| **Jasmin** | `Wole Soyinka Fashion Show` | 1 | (unknown — pass through) | unchanged | ✓ preserved |
| **Jasmin** | `Zoom` | 1 | (unknown — pass through) | unchanged | ⚠ should we demote `Zoom` like we demoted `ChatGPT`/`Linkedin`? |
| **Lawrence** | `Travel Planning` | 3 | (unknown — pass through) | unchanged | ✓ preserved |
| **Lawrence** | `Djing` | 3 | (unknown — pass through) | unchanged | ✓ preserved |
| **Lawrence** | `FlightPath MCP` | 2 | (unknown — pass through) | unchanged | ✓ preserved (his own MCP project) |
| **Lawrence** | `Pūrmemo` | 1 | `purmemo` | normalized | ✓ correct merge |
| **Lawrence** | `Mid City Runners TSP` | 1 | (unknown — pass through) | unchanged | ✓ preserved |
| **Lawrence** | `Reference Library` | 1 | (unknown — pass through) | unchanged | ✓ preserved |
| **Lawrence** | `The Speed Project` | 1 | (unknown — pass through) | unchanged | ✓ preserved |
| **Lawrence** | `AI Travel Agent` | 1 | (unknown — pass through) | unchanged | ✓ preserved |

**Result:** 0 false positives. The only matches against the alias map are `Pūrmemo` → `purmemo` (correct intended behavior — Jasmin and Lawrence both have purmemo memories that should land in their per-user purmemo cluster).

**One consideration:** Jasmin has `Zoom` as a project_name (1 memory). My garbage list doesn't include `Zoom`. Should it be demoted as a tool, or is it a real project for her (e.g. a "Zoom Workshop")? Ambiguous; **leave as pass-through** — better to over-preserve than over-demote for users we don't know.

## Test 2 — Title-rescue rule firing on their orphans

Did MY orphan rescue rules over-trigger on THEIR titles? Counts only — no title strings inspected.

| User | Total orphans | purmemo | kanvo | krawlr | puremail | portfolio | openclaw | wing | clo-lean | kiru |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Jasmin** | 98 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Lawrence** | 200 | 0 | 0 | 0 | 0 | **28** | 0 | **39** | 0 | 0 |

**Jasmin: zero matches — perfect.** None of MY title-rescue rules accidentally pull in her memories.

**Lawrence: two real positive matches**, both DEFENSIBLE:
- **portfolio: 28** — Lawrence has portfolio work (titles contain "portfolio"). Clusters are per-user, so he gets his OWN `portfolio` cluster (not shared with mine). This is the rule working correctly across users with similar project semantics.
- **wing: 39** — Lawrence appears to also work on Wing MCP (or related "wing" project — flight/travel given his AI Travel Agent + FlightPath MCP signal). 39 of his 200 orphans match `%wing mcp%`. Per-user clusters again — his `wing-mcp` cluster is separate from mine.

Both matches are signal, not noise. The rules are GENERIC project labels (`portfolio`, `wing-mcp`) that any user can have. Per-user cluster ownership prevents cross-user bleed.

## Test 3 — `Doc Scanner` rule audit

`LOWER(title) LIKE 'doc scanner%'` — was added to portfolio rule from Phase C analysis of MY 30-row sample. Live check across all users:

| User | doc_scanner prefix | doc_scanner anywhere | portfolio anywhere |
|---|---:|---:|---:|
| chris | 0 | 18 | 40 |
| lawrence | 0 | 0 | 28 |

**Finding:** strict prefix match is ZERO for everyone. The rule is dead code — none of my `Doc Scanner` titles actually start with that string (they're prefixed with `Portfolio - Doc Scanner...`). The `%portfolio%` rule already catches them.

**Recommendation:** drop `LOWER(title) LIKE 'doc scanner%'` from RULE-3 in migration 093. Pure dead code, doesn't hurt but adds noise.

## Test 4 — orphan-rescue overall hit rate per user

Same rules, applied at population level:

| User | Orphans before | Rescued by rules | Orphans after | General % before | General % after |
|---|---:|---:|---:|---:|---:|
| chris | 1,278 | 657 | 621 | 40.5% | 19.7% |
| lawrence | 200 | ~67 (28 portfolio + 39 wing) | ~133 | 93.9% | 62.4% |
| jasmin | 98 | 0 | 98 | 94.2% | 94.2% |

**Lawrence:** rescue effective — General drops from 94% to 62%. His `wing-mcp` cluster surfaces with 39 memories, his `portfolio` cluster gets 28 rescued, plus his existing 13 with project_name. Big improvement.

**Jasmin:** rescue ineffective — none of her orphan titles match my patterns. Her general bucket stays at 94%. **This is correct behavior** — her work (Mia Secret LA Pop-Up, Wole Soyinka Fashion Show, Travel) doesn't share project naming conventions with mine, so my rules shouldn't pull her memories anywhere. She'll need her own rescue patterns based on HER project signals (a future Phase F if she ever has enough data to calibrate against).

## Privacy guarantee

Throughout Phase E, Claude (me) read ONLY:
- `project_name` STRING values (220 raws for chris, 8 for lawrence, 5 for jasmin) — these are project labels, not content
- COUNT aggregates from title pattern matches (e.g. "39 of Lawrence's titles match `%wing mcp%`")

No memory **titles** as strings were returned. No memory **content** was read. The migration's effectiveness was verified against derived counts only.

## Conclusions for Phase D readiness

1. **Migration 093 is safe to apply to production.** Per-user cluster isolation means rules can't leak content between users.
2. **Drop the `doc scanner%` prefix from RULE-3.** Dead code (zero matches across all users, including me).
3. **Lawrence will gain meaningful clusters** (`portfolio`, `wing-mcp`) — net positive.
4. **Jasmin sees no improvement** from this calibration — that's correct, not a bug. Her data needs its own calibration when there's enough volume.
5. **No false positives detected.** Pass-through behavior preserves all unknown raws (Djing, Travel Planning, Mia Secret, Wole Soyinka, etc.)
6. **Future work — Phase F (deferred):** when more users have ≥100 memories, run a calibration pass per user. Build a per-user `project_aliases` row (with `user_id` column) to allow user-specific rescues without polluting the global rule set.

## Cleanup action

Drop the `'doc scanner%'` prefix from migration 093.
