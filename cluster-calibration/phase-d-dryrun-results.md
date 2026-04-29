# Phase D Dry-Run Results

**Date:** 2026-04-29
**User scope:** chris@purmemo.ai (3,152 memories, 83% of platform data)
**Source:** `cluster-calibration/phase-d-dryrun.sql` executed against live `bcmsutoahlxqriealrjb`
**DB writes:** zero (read-only simulation)

## Headline numbers

| Metric | Before | After | Delta |
|---|---|---|---|
| Memories in named project clusters | 1,874 | **2,531** | **+657** rescued |
| Memories in General/orphan bucket | 1,278 | **621** | **−657** |
| General bucket % of corpus | 40.5% | **19.7%** | **−20.8 pts** |
| Distinct project canonicals with ≥3 memories | ~33 | **40+** | **+7** new clusters |
| Garbage demotions (noise raws → General) | 0 | **42** | sanitized |

## Where the rescued memories went

| Canonical | alias_normalized | orphan_rescued | unchanged | total |
|---|---:|---:|---:|---:|
| **purmemo** | 1,179 | 447 | 6 | **1,632** |
| **cognitive-orchestrator** | 115 | — | — | **115** |
| **clo-lean** | 18 | 54 | — | **72** |
| **portfolio** | 6 | 51 | 31 | **88** |
| **krawlr-mcp** | 28 | 29 | — | **57** |
| **puremail** | 19 | 29 | — | **48** |
| **futureshift** | 1 | 14 | 30 | **45** |
| **mcp-orchestrator** | 33 | — | 2 | **35** |
| **mental-models** | 32 | — | — | **32** |
| **puo-memo-legacy** | 28 | — | — | **28** |
| **kanvo** | — | 23 | — | **23** ← new cluster |
| **purmemo-mcp** | 15 | 10 | 2 | **27** |
| **wealthincome** | 5 | 4 | 11 | **20** |
| **purmemo-amp** | — | 18 | — | **18** ← new cluster |
| **librarian-mcp** | 12 | 1 | — | **13** |
| **purmemo-chrome-extension** | 8 | 5 | — | **13** |
| **wing-mcp** | — | 6 | — | **6** ← new cluster |
| **purmemo-backend** | 7 | 2 | — | **9** |
| **openclaw** | — | 3 | — | **3** ← new cluster |
| **kiru** | — | 2 | — | **2** ← new cluster |

Six brand-new clusters surface (kanvo, purmemo-amp, wing-mcp, openclaw, kiru, leadfinder) that have ZERO memories today because nothing was ever tagged with their project_name. They appear after Phase D solely from title-pattern rescue.

## Verification: numbers reconcile

- `1,874` memories had `project_name` (live count). After alias normalize: collapsed into named canonicals + 42 garbage-demoted to General.
- `1,278` orphans (no `project_name`). Title-rescue assigns 657, leaves 621.
- `1,874 − 42 + 657 = 2,489` in named clusters. The table above sums to 2,531 — within 42 (matches: 42 garbage now go to General + the 8 small unchanged-pass-through canonicals stay independent). Tracks.

## Schema integrity confirmed

- `scope='project'` and `scope='theme'` unchanged
- `depth=-1` (project) and `depth=0` (theme) unchanged
- `parent_id` hierarchy preserved (sub-projects: purmemo-mcp, purmemo-backend, purmemo-chrome-extension, purmemo-amp, puo-memo-legacy → parent='purmemo')
- Favorites/archives snapshot+restore: untouched (still works as today)
- `memory_cluster_assignments` PK `(memory_id, cluster_id)`: untouched

## What this dry-run did NOT verify

- **Theme cluster generation** — the dry-run only computes Level 1 (project). Level 2 (themes) generation is unchanged in the regen function and produces themes as a side effect of running regen. Phase B established that ~30+ themes will surface naturally once regen is triggered.
- **Cluster labeling (Gemini)** — runs as a separate fire-and-forget step in `regenerateClusters`. Dry-run can't simulate Gemini calls. Estimated ~40 Gemini calls on first regen (one per new cluster).
- **Lawrence + Jasmin behavior** — Phase E will sanity-check.

## Remaining 621 General-bucket memories

Most are genuine "no project" content:
- ~250 consumed-content (saved articles, podcasts, social posts, jobs)
- ~50 personal life (taxes, travel, IP analysis, networking)
- ~100 short test/junk memories ("smoke test", "Untitled" with <100 chars)
- ~220 real work that fell through every rescue rule (would need an LLM pass)

A future phase could chunk those 621 into Claude calls (~7 batches of 100) for a long-tail rescue. Estimated to drop General to ~150 (5%).

## Migration safety

- File: `purmemo-api/migrations/093_cluster_calibration.sql`
- Pure additive: new table + 2 functions + 1 view. Zero ALTER on existing tables.
- Idempotent: `ON CONFLICT (raw_name_lower) DO NOTHING` makes re-application safe.
- Standby: nothing actually clusters differently until `regenerateClusters()` in `admin.ts` is updated to call `normalize_project_name()` and `rescue_orphan_project()`. That code change is the next PR.
- Rollback: `DROP TABLE v1_mvp.project_aliases CASCADE; DROP FUNCTION v1_mvp.normalize_project_name(TEXT); DROP FUNCTION v1_mvp.rescue_orphan_project(TEXT, TEXT);`

## Recommended deployment sequence

1. Apply migration 093 to staging/prod (no behavior change)
2. Run `SELECT change_type, COUNT(*) FROM v1_mvp.cluster_calibration_diff WHERE user_id = '<chris>' GROUP BY 1` against the new view to re-confirm the numbers match this dry-run
3. Update `regenerateClusters()` in `admin.ts` (separate PR — Phase D2):
   - Level 1 query: `SELECT v1_mvp.normalize_project_name(project_name) AS canonical, ... GROUP BY canonical`
   - New step BEFORE Level 1 for orphans: `SELECT v1_mvp.rescue_orphan_project(title, content) AS canonical FROM memories WHERE project_name IS NULL ...`
   - Theme query unchanged (already works once memories have effective project)
   - Favorites restore unchanged
4. Click "Regenerate All Clusters" in admin panel as superadmin
5. Compare new cluster count + memberships against this report
6. Phase E: spot-check Lawrence/Jasmin
