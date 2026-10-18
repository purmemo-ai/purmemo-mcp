Work on something with your purmemo memory loaded. The user's input after `/purmemo` is the task or question; your past context comes first, then the work.

## How to use

### If no input (just "/purmemo")
Catch the user up:
1. Call `mcp__purmemo-local__get_user_context` — who they are and what they are working on.
2. Call `mcp__purmemo-local__recall_memories` with their current project or focus as the query, `limit`: 5.
3. Present a short briefing: what they were last working on, decisions made, what looks open. End with: "Usage: /purmemo [what you want to work on]".

### If input provided
Example: `/purmemo users can't log in after password reset`
1. Call `mcp__purmemo-local__get_user_context` once, so you know who you are working with.
2. Call `mcp__purmemo-local__recall_memories` with the input as the query, `limit`: 8.
3. Open the 1–3 most relevant results with `mcp__purmemo-local__get_memory_details`.
4. If the task is about a named project, product or machine and older facts might be stale, call `mcp__purmemo-local__what_changed` with that name.
5. If recall comes up thin, or the user wants what was actually said or decided in a past session, call `search_past_sessions` if it is available (beta).
6. Say in one line which memories you are using, then do the task with that context.

### Afterwards
If the work produced decisions worth keeping, offer to save them with `mcp__purmemo-local__save_conversation` (same title as an existing memory updates it).
