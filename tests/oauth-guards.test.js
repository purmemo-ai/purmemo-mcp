/**
 * OAuth page guards (2026-10-16 hardening). The login and success pages are
 * filled by string replacement, so every interpolated value must be provably
 * unable to escape its attribute or JS string literal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  escapeHtml, isSafeParams, validateRedirectUri, buildCallbackUrl, jsStringLiteral, isAllowedRedirectTarget, DEFAULT_REDIRECT_HOSTS
} from '../dist/remote/oauth-guards.js';

describe('isSafeParams', () => {
  it('accepts the base64/base64url blobs we mint, and empty', () => {
    assert.equal(isSafeParams(''), true);
    assert.equal(isSafeParams(undefined), true);
    assert.equal(isSafeParams('eyJjbGllbnRfaWQiOiJ4In0'), true);
    assert.equal(isSafeParams('abc=='), true);
  });
  it('refuses anything that could close an attribute or open a tag', () => {
    assert.equal(isSafeParams('"><script>alert(1)</script>'), false);
    assert.equal(isSafeParams("x' onmouseover='1"), false);
    assert.equal(isSafeParams('a b'), false);
    assert.equal(isSafeParams(['x']), false);
    assert.equal(isSafeParams('a'.repeat(5000)), false);
  });
});

describe('escapeHtml', () => {
  it('neutralises the five HTML metacharacters', () => {
    assert.equal(escapeHtml(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
    assert.equal(escapeHtml(null), '');
  });
});

describe('validateRedirectUri', () => {
  it('accepts https and loopback http, normalised', () => {
    assert.equal(validateRedirectUri('https://claude.ai/api/mcp/auth_callback'), 'https://claude.ai/api/mcp/auth_callback');
    assert.equal(validateRedirectUri('http://localhost:6274/oauth/callback'), 'http://localhost:6274/oauth/callback');
    assert.equal(validateRedirectUri('http://127.0.0.1:3000/cb?x=1'), 'http://127.0.0.1:3000/cb?x=1');
  });
  it('accepts private-use app schemes used by native editors', () => {
    assert.equal(validateRedirectUri('cursor://anysphere.cursor-retrieval/oauth/user-x/callback'), 'cursor://anysphere.cursor-retrieval/oauth/user-x/callback');
    assert.equal(validateRedirectUri('vscode://ms-vscode.mcp/callback'), 'vscode://ms-vscode.mcp/callback');
  });
  it('rejects javascript:, data:, relative, http to the internet, creds and fragments', () => {
    for (const bad of [
      'javascript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y', 'about:blank', '/relative', 'claude.ai/cb', '',
      'http://evil.example/cb', 'https://user:pw@claude.ai/cb', 'https://claude.ai/cb#frag',
      '";alert(1);//', null, undefined, 42, 'https://' + 'a'.repeat(3000)
    ]) assert.equal(validateRedirectUri(bad), null, `should reject ${String(bad).slice(0, 40)}`);
  });
});

describe('buildCallbackUrl + jsStringLiteral', () => {
  it('encodes code and state so they cannot add parameters', () => {
    assert.equal(buildCallbackUrl('https://c.ai/cb', 'code_a+b', 'st&x=1'), 'https://c.ai/cb?code=code_a%2Bb&state=st%26x%3D1');
    assert.equal(buildCallbackUrl('https://c.ai/cb?k=v', 'c'), 'https://c.ai/cb?k=v&code=c');
  });
  it('produces a JS literal that cannot close the string or the script tag', () => {
    const nasty = 'https://c.ai/cb?state="</script><script>alert(1)</script>&x=$&$\'' + String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    const lit = jsStringLiteral(nasty);
    assert.ok(lit.startsWith('"') && lit.endsWith('"'));
    assert.ok(!lit.includes('</script>'), 'must not contain a literal </script>');
    assert.ok(!lit.includes(String.fromCharCode(0x2028)) && !lit.includes(String.fromCharCode(0x2029)), 'line separators are escaped');
    assert.equal(JSON.parse(lit), nasty, 'it is valid JSON that round-trips');
    assert.equal(Function(`return ${lit}`)(), nasty, 'and valid JS that round-trips');
    // The way start.ts uses it: a replacer FUNCTION, so $& and $' are never interpreted.
    const page = '<script>go("<!-- REDIRECT_URL -->");</script><p>tail</p>';
    const out = page.replace('"<!-- REDIRECT_URL -->"', () => lit);
    assert.equal(out.split('<script>').length, 2, 'no second <script> appeared');
    assert.ok(!out.includes('tail</p>");'), "$' did not splice the page tail into the literal");
  });
});

describe('isAllowedRedirectTarget', () => {
  it('allows the clients we serve, their subdomains, loopback and app schemes', () => {
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'https://www.figma.com/cb', 'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://app.purmemo.ai/cb', 'http://localhost:6274/cb', 'http://127.0.0.1:3000/cb', 'cursor://anysphere.cursor-retrieval/oauth/cb', 'vscode://ms.mcp/cb'])
      assert.equal(isAllowedRedirectTarget(ok, {}), true, ok);
    assert.ok(DEFAULT_REDIRECT_HOSTS.includes('claude.ai'));
  });
  it('refuses unknown https hosts and look-alikes', () => {
    for (const bad of ['https://evil.example/cb', 'https://claude.ai.evil.example/cb', 'https://notclaude.ai/cb', 'https://claude.ai@evil.example/cb', 'http://evil.example/cb'])
      assert.equal(isAllowedRedirectTarget(bad, {}), false, bad);
  });
  it('operator can extend the list by env, subdomains included', () => {
    const env = { PURMEMO_OAUTH_REDIRECT_ALLOW: 'partner.example, other.test' };
    assert.equal(isAllowedRedirectTarget('https://partner.example/cb', env), true);
    assert.equal(isAllowedRedirectTarget('https://app.other.test/cb', env), true);
    assert.equal(isAllowedRedirectTarget('https://evil.example/cb', env), false);
  });
});
