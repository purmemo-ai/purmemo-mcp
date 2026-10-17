/**
 * Pure guards for the OAuth pages served by the remote server.
 *
 * Everything that gets pasted into login.html / success.html goes through
 * here. The templates are plain string replacement, so the only safe values
 * are ones that provably cannot break out of the HTML attribute or the JS
 * string literal they land in.
 */

/** HTML-escape a value for use inside an attribute or text node. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The `params` round-trip value is always base64 or base64url that WE produced.
 * Anything else is not ours and is refused rather than escaped, so the login
 * page never carries attacker-shaped data at all.
 */
export function isSafeParams(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_+/=-]+$/.test(value);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Schemes that can run script or read local files if a browser follows them.
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'ftp:']);

/**
 * Validate an OAuth redirect_uri. Returns the string unchanged when it is
 * acceptable, or null when it must be rejected.
 *   - must parse as an absolute URL
 *   - https; http only to a loopback host (local MCP clients such as mcp-remote)
 *   - private-use app schemes (RFC 8252 §7.1, e.g. cursor://, vscode://) are
 *     allowed so native editors keep working; script/file schemes never are
 *   - no embedded credentials, no fragment
 */
export function validateRedirectUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return null;
  // Return the ORIGINAL string, not url.href: /oauth/token compares the client's
  // redirect_uri byte-for-byte with what we stored, and WHATWG normalisation
  // (dropping :80, adding a trailing slash) would break that match.
  if (url.protocol === 'https:') return value;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? value : null;
  // private-use scheme: must look like one (letters, digits, + . -) and have an authority or path
  if (/^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && (url.hostname || url.pathname.length > 1)) return value;
  return null;
}

/**
 * Build the callback URL the success page will navigate to. `code` and
 * `state` are always URL-encoded so they cannot smuggle extra parameters.
 */
export function buildCallbackUrl(redirectUri: string, code: string, state?: string | null): string {
  const sep = redirectUri.includes('?') ? '&' : '?';
  let url = `${redirectUri}${sep}code=${encodeURIComponent(code)}`;
  if (state) url += `&state=${encodeURIComponent(state)}`;
  return url;
}

/**
 * Serialise a value for insertion inside a <script> block as a JS string
 * literal. JSON.stringify handles quotes/backslashes; the extra replacements
 * stop `</script>` and U+2028/2029 from terminating the block or the literal.
 */
export function jsStringLiteral(value: string): string {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}
