/**
 * Regression tests for setup CLI branch decisions.
 *
 * The headline rule: `purmemo add` (forceNewProfile=true) MUST NEVER read
 * PURMEMO_API_KEY. A stale env var would silently hijack the OAuth flow and
 * re-confirm whichever account the key belongs to — the exact bug shipped in
 * v15.6.0 and fixed in v15.6.1.
 *
 * Same class of failure as ADR-031 / Jode-Leigh cross-account saves
 * (2026-04-24). If this test fails, profile isolation has a hole.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldUseEnvVarAuth } from '../dist/auth/setup-decisions.js';

describe('shouldUseEnvVarAuth — env-var hijack guard', () => {
  it('fires when PURMEMO_API_KEY is set and forceNewProfile is false', () => {
    assert.strictEqual(
      shouldUseEnvVarAuth({ envApiKey: 'sk-purmemo-existing', forceNewProfile: false }),
      true
    );
  });

  it('does NOT fire when forceNewProfile is true (purmemo add)', () => {
    assert.strictEqual(
      shouldUseEnvVarAuth({ envApiKey: 'sk-purmemo-stale-from-shell', forceNewProfile: true }),
      false,
      '`purmemo add` must run OAuth even when PURMEMO_API_KEY is set in the shell'
    );
  });

  it('does NOT fire when PURMEMO_API_KEY is absent', () => {
    assert.strictEqual(
      shouldUseEnvVarAuth({ envApiKey: undefined, forceNewProfile: false }),
      false
    );
    assert.strictEqual(
      shouldUseEnvVarAuth({ envApiKey: undefined, forceNewProfile: true }),
      false
    );
  });

  it('treats empty string as absent', () => {
    assert.strictEqual(
      shouldUseEnvVarAuth({ envApiKey: '', forceNewProfile: false }),
      false
    );
  });
});
