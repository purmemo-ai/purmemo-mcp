// @ts-nocheck — typing deferred (matches server.ts convention)
/**
 * Account-aware tool plumbing (2026-10-25): which tools take `account`, the label on their results,
 * and the transfer_memory tool. The rules live in ../auth/accounts.ts.
 */
import {
  runAsAccount, AccountSelectorError, auditAccountUse, destinationCredential, defaultAccount,
  validateSelector, accountProperty, signedInAccounts, multiAccountEnabled,
} from '../auth/accounts.js';

/** Tools that accept `account` when several accounts are signed in. */
export const ACCOUNT_TOOLS = ['save_conversation', 'recall_memories', 'get_memory_details', 'what_changed', 'get_user_context', 'search_past_sessions'];
/** Of those, the ones that write (always audit-logged on a non-default account). */
const WRITE_TOOLS = new Set(['save_conversation']);

export const TRANSFER_TOOL_NAME = 'transfer_memory';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(t: string, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

/** Add the `account` property to account-aware tools and append transfer_memory, when several accounts are signed in. */
export function withAccountTools(tools: any[], transferTool: any, env = process.env, argv = process.argv): any[] {
  if (!multiAccountEnabled(env, argv)) return tools;
  const prop = accountProperty(signedInAccounts(), defaultAccount(env));
  const out = tools.map((t) => (ACCOUNT_TOOLS.includes(t.name)
    ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema?.properties || {}), account: prop } } }
    : t));
  return [...out, transferTool];
}

/**
 * Run one tool call on the account it names (or the default). Strips `account` from the arguments the
 * handler sees, labels the result with the account when it is not the default, audits non-default use.
 */
export async function callOnAccount(name: string, args: any, runWithApiKey, handler: (a: any) => Promise<any>) {
  const a = args && typeof args === 'object' ? { ...args } : {};
  const selector = a.account;
  delete a.account;
  if (selector !== undefined && !ACCOUNT_TOOLS.includes(name)) {
    return text(`❌ ${name} does not take an account. Run it without "account".`, true);
  }
  try {
    const { result, scope } = await runAsAccount(selector, runWithApiKey, () => handler(a));
    if (scope && !scope.isDefault) {
      auditAccountUse({ tool: name, account: scope.email, write: WRITE_TOOLS.has(name), ok: !result?.isError });
      if (result?.content?.length) {
        return { ...result, content: [{ type: 'text', text: `Account: ${scope.email}` }, ...result.content] };
      }
    }
    return result;
  } catch (err) {
    if (err instanceof AccountSelectorError) return text(`❌ ${err.message}`, true);
    throw err;
  }
}

/** The transfer_memory tool definition (listed only when several accounts are signed in). */
export function transferToolDefinition() {
  return {
    name: TRANSFER_TOOL_NAME,
    annotations: { title: 'Move Memory to Another Account', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      'Move ONE memory from one of your signed-in purmemo accounts to another (for example from personal to work). ' +
      'The move is atomic: afterwards the memory, its extracted facts and media belong only to the destination account. ' +
      'Only use it when the user asked to move this memory. Multi-part documents are not moved by this tool yet.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'The memory id (a UUID, as shown by recall_memories / get_memory_details).' },
        to_account: { type: 'string', description: 'Email of the signed-in account to move it to.' },
        from_account: { type: 'string', description: 'Email of the signed-in account that holds it now. Omit for the default account.' },
      },
      required: ['memoryId', 'to_account'],
    },
  };
}

/**
 * transfer_memory: validate both accounts against the signed-in set, refuse multi-part documents,
 * then POST /api/v1/memories/:id/transfer as the source with the destination's credential.
 * `makeApiCall` is injected (it already honours the per-call key) so this is testable offline.
 */
export async function handleTransferMemory(args: any, deps: { makeApiCall: Function; runWithApiKey: Function }) {
  const a = args || {};
  const id = String(a.memoryId || a.memory_id || '').trim();
  if (!UUID.test(id)) return text('❌ memoryId must be a memory UUID (an ordinal like "1" is not accepted for a move).', true);
  let to, from;
  try {
    to = validateSelector(a.to_account);
    from = a.from_account ? validateSelector(a.from_account) : (defaultAccount() || '').toLowerCase();
    if (!from) throw new AccountSelectorError('No default account is set on this machine; name from_account.');
    validateSelector(from);
  } catch (err) {
    if (err instanceof AccountSelectorError) return text(`❌ ${err.message}`, true);
    throw err;
  }
  if (to === from) return text(`❌ The memory is already in ${from}.`, true);

  try {
    const { result } = await runAsAccount(from, deps.runWithApiKey, async () => {
      const mem = await deps.makeApiCall(`/api/v1/memories/${id}/`, { method: 'GET' });
      const conv = String(mem?.conversation_id || mem?.metadata?.conversationId || '');
      const linked = mem?.metadata?.totalParts || mem?.metadata?.total_parts || mem?.metadata?.isChunked;
      if (/:part:\d+$|:index$/.test(conv) || linked) {
        return text(`❌ ${id} is part of a multi-part document (${conv || 'chunked'}). Moving multi-part documents is not supported yet; nothing was moved.`, true);
      }
      const { credential } = await destinationCredential(to);
      await deps.makeApiCall(`/api/v1/memories/${id}/transfer`, {
        method: 'POST', body: JSON.stringify({ destination_credential: credential }),
      });
      return text(`✅ Moved memory ${id}${mem?.title ? ` ("${String(mem.title).slice(0, 80)}")` : ''} from ${from} to ${to}. It now exists only in ${to}.`);
    });
    auditAccountUse({ tool: TRANSFER_TOOL_NAME, from, to, memory_id: id, ok: !result?.isError });
    return result;
  } catch (err) {
    const msg = String(err?.message || err);
    auditAccountUse({ tool: TRANSFER_TOOL_NAME, from, to, memory_id: id, ok: false, error: msg.slice(0, 120) });
    if (err instanceof AccountSelectorError) return text(`❌ ${msg}`, true);
    if (/\b404\b/.test(msg)) return text(`❌ ${from} has no memory ${id} (it may already have been moved). Nothing was moved.`, true);
    if (/\b403\b/.test(msg)) return text(`❌ The server refused the sign-in for ${to}. Reconnect it with: purmemo-mcp-setup add. Nothing was moved.`, true);
    return text(`❌ The move failed: ${msg.slice(0, 200)}. Nothing was moved unless a later check shows it in ${to}.`, true);
  }
}
