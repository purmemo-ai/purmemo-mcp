# Purmemo iOS - Session Log - March 29, 2026

## What Shipped

### Backend (purmemo-api) - 5 commits
1. **Recursive CTE for project name resolution** - walks full cluster hierarchy (5 levels) instead of 2-level COALESCE. Fixes "Other" on all items.
2. **Open items + blocker counts** on project cards via descendant CTE with ANCHOR_ID pattern.
3. **has_media=true filter** + thumbnail URLs on memories list endpoint.
4. **Entity editing** via PATCH /api/v1/memories/:id.
5. **Project dedup** - server-side TypeScript merge of clusters with same name (case-insensitive).

### iOS - Major UI Overhaul

**MediaView (NEW):** 2-column masonry grid (Cosmo-inspired), metallic gradient borders, play/multi-image badges, skeleton placeholders, pull-to-refresh, FAB.

**MediaDetailView (NEW):** matchedGeometryEffect hero zoom, native sheet detents (.fraction(0.4) + .large), docked title bar, pull-to-dismiss, full-bleed preview.

**MemoryDetailView rewrite:** Structured intelligence (Key Insights, Action Items, Blockers, Entities, Technologies) instead of raw content. Editable entities with X to remove. Horizontal scroll for entities/tech.

**ProjectsView:** Timeline groups (Today/Yesterday/This Week/This Month/Earlier), no raw dates, full-width cards, pull-to-refresh.

**App-wide:** 4-tab layout, RingLoader (single image rotation), updated wordmark, "Save once. Recall everywhere you work." tagline, consistent headers, liquid glass tab bar.

## Key Bugs Fixed
- `struct Observation` shadowing Observation framework → `MemoryObservation`
- Descendants CTE self-join (`sc.id = sc.id`) → ANCHOR_ID placeholder
- Duplicate project cards → server-side case-insensitive dedup
- matchedGeometryEffect multiple sources → isSource flag
- GeometryReader breaking .refreshable → use UIScreen.main.bounds
- Tap targets misaligned in masonry → .contentShape + .onTapGesture

## Key Decisions
- Native sheet detents > custom drag gestures (buttery smooth)
- No per-project filtering (name matching unreliable across CTE boundaries)
- Backend dedup > client-side dedup (fix at the source)
- Single ring image rotation > 46-frame animation (simpler, no jank)
