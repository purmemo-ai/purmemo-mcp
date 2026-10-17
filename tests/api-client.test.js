import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';

import { makeApiCall, getEffectiveApiKey, apiCircuitBreaker, makeReadCall, initApiClient } from '../dist/lib/api-client.js';

describe('api-client', () => {

   let originalFetch;

   before(() => {
       originalFetch = globalThis.fetch;
       initApiClient({ apiUrl: 'http://test', resolveApiKey: () => 'test-key', clientVersion: '1.0.0' });
   });

   after(() => {
       globalThis.fetch = originalFetch;
       initApiClient({ apiUrl: '', resolveApiKey: () => null, clientVersion: '' });
   });

   describe('makeApiCall', () => {
       it('handles 401', async () => {
           globalThis.fetch = async () => ({
               ok: false,
               status: 401,
               statusText: 'Unauthorized',
               text: async () => '{"error": "invalid_token"}'
           });

           try {
               await makeApiCall('/test');
               assert.fail('Should have thrown');
           } catch (e) {
               assert.match(e.message, /401/);
               assert.strictEqual(e.kind, 'auth');
           }
       });

       it('handles quota exceeded (429)', async () => {
           globalThis.fetch = async () => ({
               ok: false,
               status: 429,
               statusText: 'Too Many Requests',
               text: async () => '{"message": "Monthly quota exceeded", "current_usage": 100, "quota_limit": 100}'
           });

           try {
               await makeApiCall('/test');
               assert.fail('Should have thrown');
           } catch (e) {
               assert.match(e.message, /Monthly quota exceeded/);
               assert.strictEqual(e.kind, 'quota');
           }
       });

       it('handles WAF 403', async () => {
           globalThis.fetch = async () => ({
               ok: false,
               status: 403,
               statusText: 'Forbidden',
               text: async () => '<!DOCTYPE html>Blocked by Cloudflare'
           });

           try {
               await makeApiCall('/test');
               assert.fail('Should have thrown');
           } catch (e) {
               assert.match(e.message, /security filtering/);
               assert.strictEqual(e.kind, 'waf');
           }
       });

       it('circuit breaker exposes its state and failure count', async () => {
          assert.ok(['CLOSED', 'OPEN', 'HALF_OPEN'].includes(apiCircuitBreaker.state), apiCircuitBreaker.state);
          assert.strictEqual(typeof apiCircuitBreaker.failureCount, 'number');
       });
   });
});

describe('makeApiCall edge cases', () => {
let originalFetch;
before(() => { originalFetch = globalThis.fetch; initApiClient({ apiUrl: 'http://test', resolveApiKey: () => 'test-key', clientVersion: '1.0.0' }); });
after(() => { globalThis.fetch = originalFetch; initApiClient({ apiUrl: '', resolveApiKey: () => null, clientVersion: '' }); });
    it('handles unexpected errors', async () => {
        globalThis.fetch = async () => ({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'Internal Server Error'
        });
        try {
            await makeApiCall('/test');
            assert.fail('Should have thrown');
        } catch (e) {
            assert.match(e.message, /500/);
        }
    });

    it('handles successful requests', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ success: true })
        });
        const result = await makeApiCall('/test');
        assert.deepStrictEqual(result, { success: true });
    });
});
