/**
 * Tests for detectInstallMethod() — the routing logic that drives
 * `purmemo --update`.
 *
 * Pure function: given a packageDir + globalRoot, returns one of
 * 'global' | 'npx' | 'local' | 'unknown'. No filesystem or shell calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import { detectInstallMethod } from '../dist/auth/install-detection.js';

describe('detectInstallMethod', () => {
  it('detects global install under npm root -g', () => {
    const result = detectInstallMethod(
      '/usr/local/lib/node_modules/purmemo-mcp',
      '/usr/local/lib/node_modules'
    );
    assert.strictEqual(result, 'global');
  });

  it('detects global install in user-local prefix (Homebrew, nvm)', () => {
    const result = detectInstallMethod(
      '/Users/me/.nvm/versions/node/v22.0.0/lib/node_modules/purmemo-mcp',
      '/Users/me/.nvm/versions/node/v22.0.0/lib/node_modules'
    );
    assert.strictEqual(result, 'global');
  });

  it('detects npx invocation', () => {
    const result = detectInstallMethod(
      '/Users/me/.npm/_npx/abc123/node_modules/purmemo-mcp',
      '/usr/local/lib/node_modules'
    );
    assert.strictEqual(result, 'npx');
  });

  it('detects npx even when globalRoot is null', () => {
    const result = detectInstallMethod(
      '/Users/me/.npm/_npx/abc123/node_modules/purmemo-mcp',
      null
    );
    assert.strictEqual(result, 'npx');
  });

  it('detects local project install', () => {
    const result = detectInstallMethod(
      '/Users/me/projects/my-app/node_modules/purmemo-mcp',
      '/usr/local/lib/node_modules'
    );
    assert.strictEqual(result, 'local');
  });

  it('local install when globalRoot is unknown', () => {
    const result = detectInstallMethod(
      '/Users/me/projects/my-app/node_modules/purmemo-mcp',
      null
    );
    assert.strictEqual(result, 'local');
  });

  it('reports unknown when running from source clone', () => {
    const result = detectInstallMethod(
      '/Users/me/code/purmemo-mcp',
      '/usr/local/lib/node_modules'
    );
    assert.strictEqual(result, 'unknown');
  });

  it('reports unknown when running from a mcpb bundle / arbitrary path', () => {
    const result = detectInstallMethod(
      '/Applications/Claude.app/Contents/Resources/mcp/purmemo',
      '/usr/local/lib/node_modules'
    );
    assert.strictEqual(result, 'unknown');
  });

  it('npx wins over global (path contains both signatures)', () => {
    // Edge case: npx caches under .npm/, global under .../lib/node_modules/.
    // If somehow both substrings appear, npx detection should run first.
    const result = detectInstallMethod(
      '/Users/me/.npm/_npx/xyz/node_modules/purmemo-mcp',
      '/Users/me/.npm/_npx/xyz/node_modules'
    );
    assert.strictEqual(result, 'npx');
  });
});
