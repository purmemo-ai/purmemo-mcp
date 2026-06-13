/**
 * Durable backing for the remote-MCP refresh-token cache.
 *
 * Why: the original in-memory `refreshTokenStore` object is wiped on every
 * Render restart. Users who go idle past a restart return to an empty store
 * and see "Session expired" because the silent-refresh path has nothing to
 * refresh with. This module persists the same tokens to the API's
 * /api/v1/internal/mcp-refresh-tokens endpoint, edge-encrypted with AES-256-GCM
 * here in the MCP server. The API only ever sees opaque ciphertext.
 *
 * Design choices (per the v3 critic round):
 *   - Edge encryption: the MCP server holds MCP_REFRESH_TOKEN_ENCRYPTION_KEY;
 *     the API never sees plaintext.
 *   - Keyed on SHA-256(apiKey) so callers don't need an id-lookup hop.
 *   - Writes are blocking with an 800ms timeout — "fire-and-forget" would
 *     silently defeat the whole point under transient API hiccups.
 *   - Fails loud at boot if MCP_INTERNAL_SECRET is set but
 *     MCP_REFRESH_TOKEN_ENCRYPTION_KEY is missing (misconfigured deploy).
 *   - If either secret is missing, every function returns gracefully so the
 *     server keeps booting and falls back to today's in-memory-only behavior.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const API_URL = process.env.API_URL ?? "https://api.purmemo.ai";
const INTERNAL_SECRET = process.env.MCP_INTERNAL_SECRET;
const ENCRYPTION_KEY_HEX = process.env.MCP_REFRESH_TOKEN_ENCRYPTION_KEY;

// Fail-loud boot check. If the operator set one secret but not the other, the
// system would degrade silently — log loudly so a misconfigured deploy is
// visible in the boot logs.
if (INTERNAL_SECRET && !ENCRYPTION_KEY_HEX) {
  console.error(
    "[refresh-token-store] MCP_INTERNAL_SECRET is set but MCP_REFRESH_TOKEN_ENCRYPTION_KEY is missing. " +
      "Refresh-token persistence is DISABLED. Set the encryption key (32 random bytes as hex) to enable.",
  );
}
if (!INTERNAL_SECRET && ENCRYPTION_KEY_HEX) {
  console.warn(
    "[refresh-token-store] MCP_REFRESH_TOKEN_ENCRYPTION_KEY is set but MCP_INTERNAL_SECRET is missing. " +
      "Refresh-token persistence is DISABLED. Set the internal secret to enable.",
  );
}

const PERSISTENCE_ENABLED = Boolean(INTERNAL_SECRET && ENCRYPTION_KEY_HEX);
if (PERSISTENCE_ENABLED) {
  console.log("[refresh-token-store] Persistence ENABLED — refresh tokens survive server restarts.");
} else {
  console.warn(
    "[refresh-token-store] Persistence DISABLED — refresh tokens are in-memory only and will be wiped on restart.",
  );
}

const KEY = ENCRYPTION_KEY_HEX ? Buffer.from(ENCRYPTION_KEY_HEX, "hex") : Buffer.alloc(0);
if (PERSISTENCE_ENABLED && KEY.length !== 32) {
  // 32 bytes = 256-bit AES key. Anything else means the operator set the wrong value.
  console.error(
    `[refresh-token-store] MCP_REFRESH_TOKEN_ENCRYPTION_KEY decoded to ${KEY.length} bytes, expected 32. ` +
      "Refresh-token persistence is DISABLED until this is fixed.",
  );
}

const READY = PERSISTENCE_ENABLED && KEY.length === 32;
const WRITE_TIMEOUT_MS = 800;
const READ_TIMEOUT_MS = 800;
const DELETE_TIMEOUT_MS = 600;

/** SHA-256(apiKey) — the table's primary key. Computed locally so callers
 *  never need an id-lookup round trip to the API. */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** AES-256-GCM encrypt. Returns `iv:ciphertext:authTag`, all hex. */
function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV for GCM (NIST recommended)
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${enc.toString("hex")}:${tag.toString("hex")}`;
}

/** Inverse of `encrypt`. Returns null on auth-tag failure (tampering / wrong key). */
function decrypt(envelope: string): string | null {
  try {
    const [ivHex, encHex, tagHex] = envelope.split(":");
    if (!ivHex || !encHex || !tagHex) return null;
    const iv = Buffer.from(ivHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch (err) {
    console.warn("[refresh-token-store] decrypt failed:", (err as Error).message);
    return null;
  }
}

/** Persist a refresh token. Blocking with a short timeout so a slow API
 *  doesn't slow the user-facing flow, but a fast write IS waited for so the
 *  durability we're paying to add actually exists before the function returns. */
export async function saveRefreshToken(
  apiKey: string,
  refreshToken: string,
  expiresAtMs: number = Date.now() + 90 * 24 * 60 * 60 * 1000, // default 90 days
): Promise<void> {
  if (!READY) return;
  const apiKeyHash = hashApiKey(apiKey);
  const ciphertext = encrypt(refreshToken);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  try {
    const r = await fetch(
      `${API_URL}/api/v1/internal/mcp-refresh-tokens/${apiKeyHash}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Mcp-Internal-Secret": INTERNAL_SECRET!,
        },
        body: JSON.stringify({
          ciphertext,
          expires_at: new Date(expiresAtMs).toISOString(),
        }),
        signal: controller.signal,
      },
    );
    if (!r.ok) {
      console.warn(`[refresh-token-store] save failed: HTTP ${r.status}`);
    }
  } catch (err) {
    // Timeout or network error — log but don't throw. The in-memory copy
    // (kept by the caller) still works until the next restart. A boot-time
    // hit to /_status will surface persistence misconfiguration separately.
    console.warn("[refresh-token-store] save error:", (err as Error).message);
  } finally {
    clearTimeout(t);
  }
}

/** Load and decrypt the refresh token for an apiKey. Returns null on 404,
 *  network error, or auth-tag failure. */
export async function loadRefreshToken(apiKey: string): Promise<string | null> {
  if (!READY) return null;
  const apiKeyHash = hashApiKey(apiKey);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const r = await fetch(
      `${API_URL}/api/v1/internal/mcp-refresh-tokens/${apiKeyHash}`,
      {
        headers: { "X-Mcp-Internal-Secret": INTERNAL_SECRET! },
        signal: controller.signal,
      },
    );
    if (r.status === 404) return null;
    if (!r.ok) {
      console.warn(`[refresh-token-store] load failed: HTTP ${r.status}`);
      return null;
    }
    const data = (await r.json()) as { ciphertext?: string };
    if (!data.ciphertext) return null;
    return decrypt(data.ciphertext);
  } catch (err) {
    console.warn("[refresh-token-store] load error:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Remove a refresh token from the durable store. Called on user logout so a
 *  Render restart cannot silently re-hydrate a session whose credential was
 *  revoked. */
export async function deleteRefreshToken(apiKey: string): Promise<void> {
  if (!READY) return;
  const apiKeyHash = hashApiKey(apiKey);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
  try {
    await fetch(
      `${API_URL}/api/v1/internal/mcp-refresh-tokens/${apiKeyHash}`,
      {
        method: "DELETE",
        headers: { "X-Mcp-Internal-Secret": INTERNAL_SECRET! },
        signal: controller.signal,
      },
    );
  } catch (err) {
    console.warn("[refresh-token-store] delete error:", (err as Error).message);
  } finally {
    clearTimeout(t);
  }
}
