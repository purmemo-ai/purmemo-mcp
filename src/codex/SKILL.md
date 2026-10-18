---
name: purmemo
description: Persistent AI conversation memory. Recall context at session start, save progress at session end. Essential for project continuity across sessions.
metadata:
  short-description: Cross-session memory for Codex
---

# Purmemo Memory Skill

You have access to purmemo MCP tools for persistent memory across sessions.

## Session Start (DO THIS FIRST)

At the START of every session, before addressing the user's request:
1. Call `recall_memories` with the current project name as query
2. Present the top 3-5 results as numbered context
3. Ask if the user wants to load any memory fully

## Session End (DO THIS BEFORE CLOSING)

Before the session ends or when significant milestones are reached:
1. Call `save_conversation` with the COMPLETE conversation content
2. Use title format: `[Project] - [Topic] - [Type]`
3. Include ALL messages verbatim — never summarize
4. Same title = updates existing memory (living document pattern)

## Available MCP Tools

| Tool | What it does |
|------|-------------|
| `save_conversation` | Save complete conversations as living documents |
| `recall_memories` | Search past memories with natural language |
| `get_memory_details` | Retrieve full memory content by ID |
| `what_changed` | What facts about a project, machine or person were replaced, with dates |
| `get_user_context` | Get your identity profile and recent work context |
| `search_past_sessions` | If available (beta): search raw past-session transcripts for what was actually said or decided |

## Structured Tasks

When the user describes a structured task (debug this, write a PRD, plan the sprint), call `recall_memories` with the task as the query, open the most relevant results with `get_memory_details`, then do the task with that context. If older facts about a named project might be stale, check `what_changed` first.

## Living Document Pattern

Same title = updates existing memory, not duplicates. Use consistent titles so sessions build on each other over time.
