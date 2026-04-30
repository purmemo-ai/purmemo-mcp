/**
 * Pure decision functions for the setup CLI.
 *
 * Lives in its own module so tests can import them without triggering the
 * setup.ts side effects (banner print, MCP registration, etc.).
 */

/**
 * Decide whether the env-var auth branch should fire in runSetup().
 *
 * RULE: `purmemo add` (forceNewProfile=true) MUST NEVER read PURMEMO_API_KEY.
 * The env var would silently hijack the OAuth flow and re-confirm whichever
 * account the stale key belongs to — same class of bug as ADR-031 /
 * Jode-Leigh cross-account saves (2026-04-24).
 */
export function shouldUseEnvVarAuth(opts: {
  envApiKey: string | undefined;
  forceNewProfile: boolean;
}): boolean {
  return Boolean(opts.envApiKey) && !opts.forceNewProfile;
}
