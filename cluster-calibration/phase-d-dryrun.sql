-- Phase D dry-run query.
--
-- Reads the LIVE v1_mvp.memories table and projects what cluster membership
-- WOULD look like AFTER migration 093 is applied AND regenerateClusters
-- runs with the calibrated logic.
--
-- This query is READ-ONLY. No DB writes.
--
-- After migration 093 is applied to the database, run:
--   SELECT * FROM v1_mvp.cluster_calibration_diff WHERE user_id = '<chris-uuid>';
--
-- Until then, this standalone CTE simulates the migration's logic against the
-- raw table.

WITH cfg AS (
  SELECT (SELECT id FROM v1_mvp.users WHERE email = 'chris@purmemo.ai') AS uid
),
-- Aliases (mirror of migration 093 seed)
aliases (raw_name, canonical_name, is_garbage) AS (
  VALUES
    ('pūrmemo','purmemo',false),('Pūrmemo','purmemo',false),('purmemo','purmemo',false),('PureMemo','purmemo',false),
    ('Purmemo Chrome Extension','purmemo-chrome-extension',false),('Pūrmemo Chrome Extension','purmemo-chrome-extension',false),
    ('Chrome-Extension-Production','purmemo-chrome-extension',false),('Chrome Extension Production','purmemo-chrome-extension',false),
    ('Chrome Extension','purmemo-chrome-extension',false),('Purmemo Extension','purmemo-chrome-extension',false),
    ('Purmemo MCP','purmemo-mcp',false),('Purmemo Mcp','purmemo-mcp',false),('Purmemo-Mcp','purmemo-mcp',false),
    ('Purmemo MCP Local Server','purmemo-mcp',false),('Puo-Memo-Mcp-Client','purmemo-mcp',false),('Puo-Memo-Mcp','purmemo-mcp',false),
    ('Purmemo MCP Tools','purmemo-mcp',false),('PUO Memo MCP Server','purmemo-mcp',false),
    ('Pūrmemo v1 MVP Backend','purmemo-backend',false),('V1 Mvp','purmemo-backend',false),('Pūrmemo v1 MVP','purmemo-backend',false),
    ('Pūrmemo Backend','purmemo-backend',false),('Purmemo-Core','purmemo-backend',false),
    ('PUO Memo Platform','puo-memo-legacy',false),('PUO Memo Multi-Tenant Platform','puo-memo-legacy',false),
    ('PUO Memo Clean Architecture','puo-memo-legacy',false),('PUO Memo ChatGPT Bridge','puo-memo-legacy',false),
    ('PUO Memory System','puo-memo-legacy',false),
    ('COS MCP','cognitive-orchestrator',false),('Cognitive Orchestrator','cognitive-orchestrator',false),
    ('CognitiveCompass','cognitive-orchestrator',false),('CognitiveCompass Orchestrator','cognitive-orchestrator',false),
    ('Cognitive-Orchestrator-Mcp','cognitive-orchestrator',false),('Cosmo','cognitive-orchestrator',false),
    ('CosMo','cognitive-orchestrator',false),('COS Hub','cognitive-orchestrator',false),
    ('COS Orchestrator','cognitive-orchestrator',false),('Cognitive-Compass-Mcp','cognitive-orchestrator',false),
    ('Portfolio','portfolio',false),('Chris Oladapo Portfolio','portfolio',false),('Chris Oladapo''s portfolio','portfolio',false),
    ('Chrisoladapo.Com Portfolio','portfolio',false),('Clofolio','portfolio',false),('DreamJob Portfolio','portfolio',false),
    ('FutureShift','futureshift',false),('Futureshift-Ai','futureshift',false),
    ('MCP Orchestrator','mcp-orchestrator',false),('Mcp-Orchestrator','mcp-orchestrator',false),
    ('MCPOrchestrator','mcp-orchestrator',false),('MCP Orchestrator V3','mcp-orchestrator',false),
    ('Orchestrator','mcp-orchestrator',false),('Orchestrator-GatherIntent','mcp-orchestrator',false),
    ('Krawlr MCP Server','krawlr-mcp',false),('Krawlr + LeadFinder','krawlr-mcp',false),
    ('LeadFinder','leadfinder',false),
    ('Mental Models Platform','mental-models',false),('Mental Models MCP','mental-models',false),
    ('Mental-Models-Platform','mental-models',false),('Mental Models MCP Platform','mental-models',false),
    ('MCP Mental Models','mental-models',false),
    ('VoiceFlow','voiceflow',false),('Nuthn','nuthn',false),
    ('Domestika-Downloader','domestika-downloader',false),('Domestika Downloader','domestika-downloader',false),
    ('Emeritus-Downloader','emeritus-downloader',false),
    ('Pūremail','puremail',false),('Clo / Lean','clo-lean',false),('Context7 MCP','context7-mcp',false),
    ('WealthIncome','wealthincome',false),('WealthIncome AI System','wealthincome',false),
    ('Wealthincome AI System','wealthincome',false),('Wealthincome Financial Tracker','wealthincome',false),
    ('WealthIncome Platform','wealthincome',false),('WealthIncome Unified Trading Platform','wealthincome',false),
    ('Creative Copilot','creative-copilot',false),('Creative-Copilot-Integration','creative-copilot',false),
    ('Personal-Creative-Copilot','creative-copilot',false),
    ('Librarian MCP','librarian-mcp',false),('Librarian','librarian-mcp',false),
    ('Desktop Commander MCP','desktop-commander-mcp',false),('DesktopCommanderMCP','desktop-commander-mcp',false),
    ('Usertesting-Mcp','usertesting-mcp',false),('UserTesting MCP','usertesting-mcp',false),
    ('Meta-MCP','meta-mcp',false),('Meta-MCP Ecosystem','meta-mcp',false),
    ('Dollavote','dollavote',false),('DollaVote','dollavote',false),
    ('Figma Bridge MCP','figma-bridge-mcp',false),('Figma-Bridge-Mcp','figma-bridge-mcp',false),
    ('Figma-Design-Automation-Plugin','figma-design-automation',false),('Figma Design Automation Plugin','figma-design-automation',false),
    ('Figma MCP','figma-mcp',false),('MCP Figma','figma-mcp',false),('Mcp-Figma','figma-mcp',false),('figma-redis MCP','figma-mcp',false),
    ('Inbox Zero MCP','inbox-zero-mcp',false),('Inbox-Zero-Mcp','inbox-zero-mcp',false),
    ('Intent Bridge MCP','intent-bridge-mcp',false),('Intent Bridge MCP Server','intent-bridge-mcp',false),
    ('Gather Intent MCP','gather-intent-mcp',false),('Gather Intent','gather-intent-mcp',false),('Gather-Intent-Mcp','gather-intent-mcp',false),
    ('Handoff-Mcp','handoff-mcp',false),('handoff MCP','handoff-mcp',false),('Handoff-v2 Unified','handoff-mcp',false),
    ('Raid Mcp','raid-mcp',false),('RAID mcp','raid-mcp',false),('Raid-C','raid-mcp',false),
    ('Email Extractor','email-extractor',false),('Email-Extractor','email-extractor',false),
    ('E-commerce Platform','ecommerce-platform',false),('E-Commerce Platform','ecommerce-platform',false),
    ('The Herbaē Method','herbae-method',false),('The Herbaē Method Website','herbae-method',false),
    ('Onlook','onlook',false),('Onlook Visual Editor','onlook',false),
    ('Slauson','slauson',false),('Slauson Prep','slauson',false),
    ('Symphony MCP','symphony',false),('Symphony Autonomy','symphony',false),('Symphony v2','symphony',false),
    ('Sequential Thinking MCP','sequential-thinking-mcp',false),('Sequential Thinking MCP Server','sequential-thinking-mcp',false),
    ('Ai',NULL,true),('Architecture',NULL,true),('Bcrypt',NULL,true),('Chatgpt',NULL,true),
    ('Claude Code',NULL,true),('Claude Desktop',NULL,true),('Claude Desktop Commander',NULL,true),
    ('Cloudwatch',NULL,true),('Cursor',NULL,true),('Cursor-Mcp',NULL,true),('Day',NULL,true),('Dia',NULL,true),
    ('Dom',NULL,true),('Dry',NULL,true),('Enter',NULL,true),('Figma',NULL,true),('Get',NULL,true),
    ('Ides',NULL,true),('Improvement',NULL,true),('Insight',NULL,true),('Issues',NULL,true),
    ('Linkedin',NULL,true),('Mcp',NULL,true),('Mem',NULL,true),('Openai',NULL,true),
    ('Project Alpha',NULL,true),('Project X',NULL,true),('Project Y',NULL,true),
    ('Rag',NULL,true),('Reddit',NULL,true),('Scripts',NULL,true),('Src',NULL,true),
    ('V0',NULL,true),('Vllm',NULL,true),('Zapier',NULL,true)
),
deduped_aliases AS (
  -- collapse case-insensitive collisions deterministically
  SELECT DISTINCT ON (LOWER(raw_name)) raw_name, canonical_name, is_garbage
  FROM aliases
  ORDER BY LOWER(raw_name), raw_name
),
-- Compute effective canonical for every memory
labeled AS (
  SELECT
    m.id,
    m.title,
    m.project_name AS raw_project,
    -- Stage 1: alias normalize for memories with project_name
    a.canonical_name AS alias_canonical,
    a.is_garbage AS alias_is_garbage,
    -- Stage 2: rescue from title for orphans (matches migration 093 logic)
    CASE
      WHEN m.project_name IS NOT NULL AND m.project_name != '' THEN NULL
      WHEN LOWER(m.title) LIKE '%purmemo amp%' OR LOWER(m.title) LIKE 'purmemoamp%' OR LOWER(m.title) LIKE 'purmemo-amp%' THEN 'purmemo-amp'
      WHEN (LOWER(m.title) LIKE '%purmemo%' OR LOWER(m.title) LIKE '%pūrmemo%' OR LOWER(m.title) LIKE '%puremem%' OR LOWER(m.title) LIKE '%puo memo%' OR LOWER(m.title) LIKE 'adr-%')
        AND (LOWER(m.title) LIKE '%purmemo chrome ext%' OR LOWER(m.title) LIKE '%purmemo extension%' OR LOWER(m.title) LIKE '%chrome-extension-production%') THEN 'purmemo-chrome-extension'
      WHEN (LOWER(m.title) LIKE '%purmemo%' OR LOWER(m.title) LIKE '%pūrmemo%' OR LOWER(m.title) LIKE 'adr-%')
        AND (LOWER(m.title) LIKE '%purmemo mcp%' OR LOWER(m.title) LIKE '%purmemo-mcp%' OR LOWER(m.title) LIKE 'puo-memo-mcp%') THEN 'purmemo-mcp'
      WHEN (LOWER(m.title) LIKE '%purmemo%' OR LOWER(m.title) LIKE '%pūrmemo%' OR LOWER(m.title) LIKE 'adr-%')
        AND (LOWER(m.title) LIKE '%v1 mvp backend%' OR LOWER(m.title) LIKE '%purmemo backend%' OR LOWER(m.title) LIKE '%v1-mvp%') THEN 'purmemo-backend'
      WHEN LOWER(m.title) LIKE '%purmemo%' OR LOWER(m.title) LIKE '%pūrmemo%' OR LOWER(m.title) LIKE '%puremem%' OR LOWER(m.title) LIKE '%puo memo%' OR LOWER(m.title) LIKE 'adr-%' THEN 'purmemo'
      WHEN LOWER(m.title) LIKE '%clo / lean%' OR LOWER(m.title) LIKE 'clo lean%' THEN 'clo-lean'
      WHEN LOWER(m.title) LIKE '%portfolio%' OR LOWER(m.title) LIKE 'doc scanner%' OR LOWER(m.title) LIKE 'clofolio%' OR LOWER(m.title) LIKE 'dreamjob%' THEN 'portfolio'
      WHEN LOWER(m.title) LIKE '%krawlr%' THEN 'krawlr-mcp'
      WHEN LOWER(m.title) LIKE '%puremail%' OR LOWER(m.title) LIKE '%pūremail%' THEN 'puremail'
      WHEN LOWER(m.title) LIKE '%kanvo%' THEN 'kanvo'
      WHEN LOWER(m.title) LIKE 'amp %' AND LOWER(m.content) LIKE '%semantic%' THEN 'purmemo-amp'
      WHEN LOWER(m.title) LIKE '%futureshift%' THEN 'futureshift'
      WHEN LOWER(m.title) LIKE '%wealthincome%' THEN 'wealthincome'
      WHEN LOWER(m.title) LIKE '%wing mcp%' OR LOWER(m.title) LIKE 'wing —%' OR LOWER(m.title) LIKE 'wing -%' THEN 'wing-mcp'
      WHEN LOWER(m.title) LIKE '%openclaw%' THEN 'openclaw'
      WHEN LOWER(m.title) LIKE '%kiru%' OR LOWER(m.title) LIKE 'watchlist%' THEN 'kiru'
      WHEN LOWER(m.title) LIKE '%domestika%' THEN 'domestika-downloader'
      WHEN LOWER(m.title) LIKE '%emeritus%' THEN 'emeritus-downloader'
      WHEN LOWER(m.title) LIKE '%librarian%' THEN 'librarian-mcp'
      ELSE NULL
    END AS rescued_from_title
  FROM v1_mvp.memories m
  LEFT JOIN deduped_aliases a ON LOWER(a.raw_name) = LOWER(m.project_name)
  WHERE m.user_id = (SELECT uid FROM cfg)
    AND m.deleted_at IS NULL
),
final AS (
  SELECT
    id,
    title,
    raw_project,
    CASE
      WHEN alias_is_garbage THEN '__General__'
      WHEN alias_canonical IS NOT NULL THEN alias_canonical
      WHEN rescued_from_title IS NOT NULL THEN rescued_from_title
      WHEN raw_project IS NOT NULL AND raw_project != '' THEN raw_project   -- pass-through unknown
      ELSE '__General__'
    END AS effective_canonical,
    CASE
      WHEN alias_canonical IS NOT NULL AND alias_canonical != COALESCE(LOWER(raw_project), '') THEN 'alias_normalized'
      WHEN alias_is_garbage THEN 'garbage_demoted'
      WHEN rescued_from_title IS NOT NULL THEN 'orphan_rescued'
      WHEN raw_project IS NULL OR raw_project = '' THEN 'still_orphan'
      ELSE 'unchanged'
    END AS change_type
  FROM labeled
)
SELECT
  effective_canonical,
  change_type,
  COUNT(*)::int AS cnt
FROM final
GROUP BY effective_canonical, change_type
ORDER BY effective_canonical, cnt DESC;
