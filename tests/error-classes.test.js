/**
 * Error classes (2026-09-18): a quota rejection is an upsell, a bad key is a setup
 * problem, and only server/network failures mean "purmemo is down". The breaker
 * must never turn the first two into the third.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { CircuitBreaker, CircuitBreakerOpenError, safeErrorMessage, tagError, makeApiCall, initApiClient, apiCircuitBreaker } from '../dist/lib/api-client.js';

describe('circuit breaker ignores 4xx (the API answered), trips on 5xx / network', () => {
  it('five quota rejections leave the breaker CLOSED', async () => {
    const b = new CircuitBreaker('t', 5, 60000);
    for (let i = 0; i < 6; i++) await b.execute(async () => { throw tagError(new Error('quota'), 429, 'quota'); }).catch(() => {});
    assert.equal(b.state, 'CLOSED'); assert.equal(b.failureCount, 0);
  });
  it('five auth rejections leave the breaker CLOSED', async () => {
    const b = new CircuitBreaker('t', 5, 60000);
    for (let i = 0; i < 6; i++) await b.execute(async () => { throw tagError(new Error('API Error 401: x'), 401, 'auth'); }).catch(() => {});
    assert.equal(b.state, 'CLOSED');
  });
  it('five server errors OPEN it, and the open error renders as "not your account"', async () => {
    const b = new CircuitBreaker('t', 5, 60000);
    for (let i = 0; i < 5; i++) await b.execute(async () => { throw tagError(new Error('API Error 503: down'), 503, 'server'); }).catch(() => {});
    assert.equal(b.state, 'OPEN');
    await assert.rejects(b.execute(async () => 'x'), CircuitBreakerOpenError);
    assert.match(safeErrorMessage(new CircuitBreakerOpenError('t')), /not your account or quota/);
  });
});

describe('safeErrorMessage says what the failure is', () => {
  it('quota → the upsell text untouched', () => {
    const m = safeErrorMessage(tagError(new Error('❌ Monthly recall quota exceeded (100/100 used).\n🚀 Upgrade to Pro: https://app.purmemo.ai/dashboard?modal=plans'), 429, 'quota'));
    assert.match(m, /Upgrade to Pro/); assert.doesNotMatch(m, /unavailable|down/i);
  });
  it('401 → setup problem, explicitly not an outage', () => { assert.match(safeErrorMessage(tagError(new Error('API Error 401: bad'), 401, 'auth')), /not an outage/); });
  it('402 → upgrade', () => { assert.match(safeErrorMessage(tagError(new Error('API Error 402: pay'), 402, 'payment')), /paid plan/); });
  it('403 → account permission, with the setup hint', () => { assert.match(safeErrorMessage(tagError(new Error('API Error 403: no'), 403, 'forbidden')), /HTTP 403/); });
  it('5xx → on our side, not your account', () => { assert.match(safeErrorMessage(tagError(new Error('API Error 503: <html>'), 503, 'server')), /server error \(HTTP 503\).*not your account/); });
  it('timeout → slow or unreachable, not your account', () => { assert.match(safeErrorMessage(tagError(new Error('Request timeout after 30 seconds'), 0, 'timeout')), /not your account/); });
  it('network → could not reach purmemo', () => { assert.match(safeErrorMessage(new Error('fetch failed: ECONNREFUSED 127.0.0.1:3200')), /Could not reach purmemo/); });
  it('other API errors show the status and the server\'s words, never a blank message', () => {
    assert.match(safeErrorMessage(tagError(new Error('API Error 422: {"detail":"query is required"}'), 422, 'client')), /query is required \(HTTP 422\)/);
    assert.match(safeErrorMessage(new Error('weird')), /Unexpected error: weird/);
  });
});

describe('makeApiCall tags real responses', () => {
  const realFetch = globalThis.fetch;
  before(() => { initApiClient({ apiUrl: 'http://api.test', resolveApiKey: () => 'k', clientVersion: '0', installMethod: 'test', platform: 'test' }); apiCircuitBreaker.state = 'CLOSED'; apiCircuitBreaker.failureCount = 0; });
  after(() => { globalThis.fetch = realFetch; });
  const respond = (status, body) => async () => ({ ok: status < 400, status, statusText: 'x', text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => body });
  it('429 with detail → kind quota + upsell message', async () => {
    globalThis.fetch = respond(429, { detail: { message: 'Monthly recall quota exceeded', current_usage: 101, limit: 100, upgrade_url: 'https://app.purmemo.ai/dashboard/plans' } });
    const err = await makeApiCall('/x').catch((e) => e);
    assert.equal(err.kind, 'quota'); assert.equal(err.status, 429); assert.match(err.message, /101\/100/); assert.match(err.message, /dashboard\/plans/);
  });
  it('401 → kind auth; 503 → kind server; neither trips the breaker', async () => {
    globalThis.fetch = respond(401, { detail: 'Invalid token' });
    const a = await makeApiCall('/x').catch((e) => e); assert.equal(a.kind, 'auth');
    globalThis.fetch = respond(503, 'down');
    const s = await makeApiCall('/x').catch((e) => e); assert.equal(s.kind, 'server'); assert.equal(s.status, 503);
    assert.equal(apiCircuitBreaker.state, 'CLOSED');
  });
});
