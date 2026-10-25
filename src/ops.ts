#!/usr/bin/env node
/**
 * purmemo-ops — account-scoped purmemo operations for programs (2026-10-25).
 *
 * The same boundary as the MCP tools' `account` argument (auth/accounts.ts), for code that is not a
 * model: Cosmo's Python, the pendant brain, scripts. Every command names its account explicitly; there is
 * no implicit default here. Output is one JSON object on stdout; keys are never printed or logged.
 *
 *   purmemo-ops accounts
 *   purmemo-ops whoami   --account <email>
 *   purmemo-ops save     --account <email> --title <t> --conversation-id <id> [--mode append|replace] [--tags a,b] [--source s]   (content on stdin)
 *   purmemo-ops recall   --account <email> --query <q> [--limit N]
 *   purmemo-ops transfer --from <email> --to <email> --id <memory uuid> --yes
 *
 * Exit codes: 0 ok, 2 bad arguments / account refused (no network call made), 3 API error.
 */
import { initApiClient, makeApiCall, runWithApiKey, wafSafeBody } from './lib/api-client.js';
import {
  AccountSelectorError, auditAccountUse, defaultAccount, runBoundToAccount, signedInAccounts, multiAccountEnabled,
} from './auth/accounts.js';
import { handleTransferMemory } from './tools/accounts.js';

const APPEND_MAX = 15000;

function out(obj: unknown, code = 0): never {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const cmd = argv[0] || '';
  const opts: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out({ ok: false, error: `unexpected argument: ${a}` }, 2);
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[k] = true;
    else { opts[k] = next; i++; }
  }
  return { cmd, opts };
}

function need(opts: Record<string, string | boolean>, k: string): string {
  const v = opts[k];
  if (typeof v !== 'string' || !v.trim()) out({ ok: false, error: `--${k} is required` }, 2);
  return (v as string).trim();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const apiUrl = (process.env.PURMEMO_API_URL || 'https://api.purmemo.ai').replace(/\/+$/, '');
  // No process-wide key: every call below is bound to the account it names.
  initApiClient({ apiUrl, resolveApiKey: () => null, clientVersion: 'ops', installMethod: 'cli', platform: 'purmemo-ops' });

  try {
    switch (cmd) {
      case 'accounts':
        out({ ok: true, accounts: signedInAccounts(), default: defaultAccount(), multi_account: multiAccountEnabled() });

      case 'whoami': {
        const { result, scope } = await runBoundToAccount(need(opts, 'account'), runWithApiKey, () => makeApiCall('/api/v1/auth/me'));
        const email = (result?.email || result?.user?.email || '').toLowerCase();
        out({ ok: email === scope.email, account: scope.email, server_email: email || null });
      }

      case 'save': {
        const account = need(opts, 'account');
        const title = need(opts, 'title');
        const conversationId = need(opts, 'conversation-id');
        const mode = typeof opts.mode === 'string' ? opts.mode : 'append';
        if (mode !== 'append' && mode !== 'replace') out({ ok: false, error: '--mode must be append or replace' }, 2);
        const content = await readStdin();
        if (content.trim().length < 20) out({ ok: false, error: 'content on stdin is empty or too short' }, 2);
        if (mode === 'append' && content.length >= APPEND_MAX) out({ ok: false, error: `an append must be under ${APPEND_MAX} characters (got ${content.length}); send a smaller delta` }, 2);
        const tags = typeof opts.tags === 'string' ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
        const source = typeof opts.source === 'string' ? opts.source : 'purmemo-ops';
        const { result, scope } = await runBoundToAccount(account, runWithApiKey, () => makeApiCall('/api/v1/memories/', {
          method: 'POST',
          body: wafSafeBody({
            content, title, tags: tags.length ? tags : ['purmemo-ops'], platform: 'claude', source_type: 'mcp',
            conversation_id: conversationId, mode,
            metadata: { conversationId, captureType: 'single', isComplete: mode === 'replace', source },
          }),
        }));
        const id = result?.id || result?.memory_id || null;
        if (!scope.isDefault) auditAccountUse({ tool: 'ops:save', account: scope.email, write: true, ok: !!id, memory_id: id });
        out({ ok: !!id, account: scope.email, id, conversation_id: conversationId, mode }, id ? 0 : 3);
      }

      case 'recall': {
        const query = need(opts, 'query');
        const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
        const { result, scope } = await runBoundToAccount(need(opts, 'account'), runWithApiKey, () => makeApiCall('/api/v10/mcp/tools/execute', {
          method: 'POST', body: JSON.stringify({ tool: 'recall_memories', arguments: { query, limit } }),
        }));
        if (!scope.isDefault) auditAccountUse({ tool: 'ops:recall', account: scope.email, write: false, ok: true });
        out({ ok: true, account: scope.email, result });
      }

      case 'transfer': {
        if (opts.yes !== true) out({ ok: false, error: 'a move needs --yes (the caller must have the owner\'s explicit OK)' }, 2);
        const r = await handleTransferMemory(
          { memoryId: need(opts, 'id'), to_account: need(opts, 'to'), from_account: need(opts, 'from') },
          { makeApiCall, runWithApiKey },
        );
        const msg = r?.content?.[0]?.text || '';
        out({ ok: !r?.isError, message: msg }, r?.isError ? 3 : 0);
      }

      default:
        out({ ok: false, error: 'usage: purmemo-ops accounts | whoami | save | recall | transfer (see the header of dist/ops.js)' }, 2);
    }
  } catch (err: any) {
    if (err instanceof AccountSelectorError) out({ ok: false, error: err.message }, 2);
    out({ ok: false, error: String(err?.message || err).slice(0, 300) }, 3);
  }
}

main();
