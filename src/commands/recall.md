Search purmemo for past conversations and knowledge.

## What to do

Call `recall_memories` with the user's query. Present results clearly.

### Steps

1. Call `mcp__purmemo-local__recall_memories` with:
   - `query`: the user's search terms (or derive from context if they just said "/recall")
   - `has_observations`: true (for substantial results only)
   - `limit`: 10

2. Present results as a numbered list:
   ```
   Found X memories:
   1. [Title] (platform, date)
      [2-line preview]
   2. ...
   ```

3. Ask: "Type a number to load the full memory, or refine your search."

4. If user picks a number, call `get_memory_details` with that memory's ID and present the full content.

### Filters (use when relevant)
- `entity="name"` — find memories about a specific person, project, or technology
- `intent="decision"` — find decisions made
- `intent="blocker"` — find past blockers and how they were resolved

### Tips
- If results aren't relevant, try different keywords or use entity filter
- Results already span every platform (ChatGPT, Claude, Gemini); search again with the names a result mentions to follow a thread
- If recall comes up thin, or the user wants what was actually said in a past session, use `search_past_sessions` if it is available (beta)
