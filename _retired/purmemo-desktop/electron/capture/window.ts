/**
 * Active window monitor — Phase 4 system-level AI context injection.
 *
 * Polls the active window every 2s using active-win.
 * When the user switches to a known AI tool, fetches their Purmemo identity
 * and session context, writes it to the clipboard, and shows a tray notification.
 *
 * The user can then paste (⌘V) into any AI app to instantly inject context —
 * no manual copy/paste of identity info ever again.
 */

import { clipboard, Notification, BrowserWindow, systemPreferences } from 'electron';
import Store from 'electron-store';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const activeWin = require('active-win') as (options?: object) => Promise<ActiveWinResult | undefined>;

interface ActiveWinResult {
  title: string;
  owner: {
    name: string;
    bundleId: string;
    processId: number;
  };
}

interface AuthMe {
  email: string;
}

interface CognitiveIdentity {
  role?: string;
  work_style?: string;
  expertise?: string[];
  tools?: string[];
  primary_domain?: string;
}

interface UserSession {
  project?: string;
  context?: string;
  focus?: string;
}

interface MemoryListResponse {
  memories: Array<{ title?: string }>;
}

// Known AI app bundle IDs (macOS) — title keyword is fallback for unrecognised bundleIds
const AI_APPS: Array<{ bundleId?: string; titleKeyword?: string; displayName: string }> = [
  { bundleId: 'com.todesktop.230313mzl4w4u92', titleKeyword: 'Cursor',              displayName: 'Cursor'          },
  { bundleId: 'com.anthropic.claudefordesktop', titleKeyword: 'Claude',              displayName: 'Claude Desktop'  },
  { bundleId: 'com.openai.chat',                titleKeyword: 'ChatGPT',             displayName: 'ChatGPT'         },
  { bundleId: 'com.google.Gemini',              titleKeyword: 'Gemini',              displayName: 'Gemini'          },
  { bundleId: 'company.thebrowser.Browser',     titleKeyword: 'Arc',                 displayName: 'Arc'             },
  { bundleId: 'com.microsoft.VSCode',           titleKeyword: 'Visual Studio Code',  displayName: 'VS Code'         },
  { bundleId: 'dev.zed.zed',                    titleKeyword: 'Zed',                 displayName: 'Zed'             },
  { bundleId: 'com.codeium.windsurf',           titleKeyword: 'Windsurf',            displayName: 'Windsurf'        },
];

const POLL_INTERVAL_MS = 2000;
const API_BASE = 'https://api.purmemo.ai';

const CURSOR_BUNDLE_ID = 'com.todesktop.230313mzl4w4u92';

let lastActiveKey = '';
let lastWasCursor = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function matchAiApp(bundleId: string, title: string): string | null {
  for (const app of AI_APPS) {
    if (app.bundleId && bundleId === app.bundleId) return app.displayName;
    if (app.titleKeyword && title.includes(app.titleKeyword)) return app.displayName;
  }
  return null;
}

function buildContextString(
  email: string,
  identity: CognitiveIdentity | null,
  session: UserSession | null,
  recentTitles: string[]
): string {
  const lines: string[] = ['## Purmemo Context'];

  lines.push(`**User**: ${email}`);
  if (identity?.role)                lines.push(`**Role**: ${identity.role}`);
  if (identity?.primary_domain)      lines.push(`**Domain**: ${identity.primary_domain}`);
  if (identity?.work_style)          lines.push(`**Work style**: ${identity.work_style}`);
  if (identity?.expertise?.length)   lines.push(`**Expertise**: ${identity.expertise.join(', ')}`);
  if (identity?.tools?.length)       lines.push(`**Tools**: ${identity.tools.join(', ')}`);

  if (session?.project || session?.context || session?.focus) {
    lines.push('');
    lines.push('**Current session**:');
    if (session.project) lines.push(`- Project: ${session.project}`);
    if (session.context) lines.push(`- Context: ${session.context}`);
    if (session.focus)   lines.push(`- Focus: ${session.focus}`);
  }

  if (recentTitles.length) {
    lines.push('');
    lines.push(`**Recent memory themes**: ${recentTitles.join(' · ')}`);
  }

  return lines.join('\n');
}

async function injectContext(token: string, appName: string): Promise<void> {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const [meRes, identityRes, sessionRes, memoriesRes] = await Promise.all([
      fetch(`${API_BASE}/api/v1/auth/me`, { headers }),
      fetch(`${API_BASE}/api/v1/users/me/identity`, { headers }),
      fetch(`${API_BASE}/api/v1/identity/session?platform=desktop`, { headers }),
      fetch(`${API_BASE}/api/v1/memories/?page=1&page_size=7&include_source_types=desktop_clipboard,manual,chrome_extension`, { headers }),
    ]);

    if (!meRes.ok) return;

    const me = await meRes.json() as AuthMe;
    const identity: CognitiveIdentity | null = identityRes.ok ? await identityRes.json() as CognitiveIdentity : null;
    const session: UserSession | null = sessionRes.ok ? await sessionRes.json() as UserSession : null;
    const recentTitles: string[] = memoriesRes.ok
      ? ((await memoriesRes.json() as MemoryListResponse).memories ?? [])
          .map(m => m.title)
          .filter((t): t is string => !!t)
      : [];

    const contextText = buildContextString(me.email, identity, session, recentTitles);
    clipboard.writeText(contextText);

    if (Notification.isSupported()) {
      new Notification({
        title: 'Purmemo',
        body: `Context ready for ${appName} — paste with ⌘V`,
        silent: true,
      }).show();
    }

    console.log(`[purmemo] context injected for ${appName} (${contextText.length} chars)`);
  } catch (err) {
    // Silently fail — context injection is best-effort
    console.warn('[purmemo] context injection failed:', err);
  }
}

// Exported for dev testing — called directly from main process test handler
export async function triggerContextInject(token: string, appName: string): Promise<void> {
  await injectContext(token, appName);
}

export function startWindowMonitor(
  getToken: () => Promise<string>,
  _getWindow: () => BrowserWindow | null,
  onCursorFocusLoss?: () => void
): void {
  if (pollInterval) return;

  // Only start if accessibility is already granted.
  // isTrustedAccessibilityClient(false) = check silently, no system prompt.
  // This prevents active-win from triggering the TCC dialog on startup.
  // The user can grant access via System Settings > Privacy & Security >
  // Accessibility and then restart Purmemo to enable AI context injection.
  if (process.platform === 'darwin') {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!trusted) {
      console.log('[purmemo] window monitor: accessibility not granted — skipping AI context injection. Grant in System Settings > Privacy & Security > Accessibility to enable.');
      return;
    }
  }

  pollInterval = setInterval(async () => {
    try {
      // Re-check on each poll — if the user revokes permission mid-session, stop.
      if (process.platform === 'darwin') {
        const trusted = systemPreferences.isTrustedAccessibilityClient(false);
        if (!trusted) {
          console.log('[purmemo] window monitor: accessibility revoked, stopping');
          stopWindowMonitor();
          return;
        }
      }

      const win = await activeWin();
      if (!win) return;

      const bundleId = win.owner?.bundleId ?? '';
      const title    = win.title ?? '';
      // Key on bundleId+title so switching between windows of the same app doesn't re-trigger
      const key = bundleId || title;

      if (key === lastActiveKey) return;

      // Detect Cursor focus-loss: previous window was Cursor, now it's something else
      const isCursor = bundleId === CURSOR_BUNDLE_ID || title.includes('Cursor');
      if (lastWasCursor && !isCursor && onCursorFocusLoss) {
        onCursorFocusLoss();
      }
      lastWasCursor = isCursor;
      lastActiveKey = key;

      const appName = matchAiApp(bundleId, title);
      if (!appName) return;

      const token = await getToken();
      if (!token) return;

      await injectContext(token, appName);
    } catch {
      // Poll errors are silent
    }
  }, POLL_INTERVAL_MS);
}

export function stopWindowMonitor(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
