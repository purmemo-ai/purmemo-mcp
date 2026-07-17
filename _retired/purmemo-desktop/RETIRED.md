# RETIRED — 2026-07-16

This Electron desktop app ("always-on memory presence") is retired. **PurmemoAMP
(`purmemo-amp`, native Swift menu-bar app) is the successor** and owns this job.

Why retired: hadn't run since 2026-02-25 while AMP took over ambient capture.
Feature disposition:
- Cursor auto-sync → AMP `backupAllSources`
- Incident/error reporting (One Pipe) → AMP has its own wiring
- Clipboard capture → superseded by the Chrome extension
- Active-window context-paste → superseded by MCP context injection

App bundle removed from /Applications same day. Do not build on this code;
if an idea here is needed, port it into purmemo-amp.
