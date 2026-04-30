/**
 * Detect how purmemo-mcp was installed so `purmemo --update` can do the
 * right thing for each install method.
 *
 *   - 'global'  → installed via `npm i -g purmemo-mcp`. Update: re-run
 *                 `npm i -g purmemo-mcp@latest`.
 *   - 'npx'     → invoked via `npx purmemo-mcp@latest`. Update: clear
 *                 ~/.npm/_npx so next invocation re-resolves.
 *   - 'local'   → installed in a project's node_modules. Update: tell the
 *                 user to bump it in their package.json.
 *   - 'unknown' → none of the above (e.g. running from source, mcpb bundle,
 *                 or symlinked dev install). Update: print manual steps.
 */

import * as path from 'node:path';

export type InstallMethod = 'global' | 'npx' | 'local' | 'unknown';

/**
 * @param packageDir Absolute path to the directory containing the installed
 *   package's package.json. In production: path.join(__dirname, '..').
 * @param globalRoot Output of `npm root -g`, or null if it can't be
 *   resolved. Pass null to skip the global check (treat as not-global).
 */
export function detectInstallMethod(
  packageDir: string,
  globalRoot: string | null
): InstallMethod {
  const norm = path.normalize(packageDir);

  // npx caches under ~/.npm/_npx/<hash>/node_modules/purmemo-mcp/
  if (norm.includes(`${path.sep}_npx${path.sep}`)) return 'npx';

  // Global install lives under `npm root -g`/purmemo-mcp/
  if (globalRoot) {
    const normGlobal = path.normalize(globalRoot);
    if (norm.startsWith(normGlobal + path.sep) || norm === normGlobal) {
      return 'global';
    }
  }

  // Local install: somewhere under a node_modules/ that isn't _npx or global
  if (norm.includes(`${path.sep}node_modules${path.sep}`)) return 'local';

  return 'unknown';
}
