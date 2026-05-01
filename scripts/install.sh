#!/bin/sh
# purmemo installer — one-line install for macOS and Linux.
#
# Usage:
#   curl -fsSL https://app.purmemo.ai/install | sh
#
# Or inspect first (recommended for the security-conscious):
#   curl -fsSL https://app.purmemo.ai/install -o install.sh
#   less install.sh
#   sh install.sh
#
# What this does:
#   1. Checks for Node.js >= 18.
#   2. If Node is missing, points you at the official installer (we don't
#      silently install runtimes on your behalf).
#   3. Runs `npm i -g purmemo-mcp` to install the CLI.
#   4. Verifies `purmemo` is on your PATH and prints next steps.
#
# Source: https://github.com/purmemo-ai/purmemo-mcp/blob/main/scripts/install.sh

set -eu

NODE_MIN_MAJOR=18
PKG="purmemo-mcp"
BIN="purmemo"

# --- pretty output -----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  RESET="$(printf '\033[0m')"
else
  BOLD="" DIM="" GREEN="" YELLOW="" RED="" RESET=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

say ""
say "${BOLD}purmemo installer${RESET}"
say "${DIM}AI memory + workflows for Claude. https://purmemo.ai${RESET}"
say ""

# --- step 1: detect Node -----------------------------------------------------
step "Checking for Node.js…"

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed."
  say ""
  say "purmemo runs on Node.js (≥ v${NODE_MIN_MAJOR}). Install it from the official"
  say "installer, then re-run this command:"
  say ""
  say "  ${BOLD}https://nodejs.org/en/download${RESET}"
  say ""
  say "On macOS with Homebrew you can also run: ${BOLD}brew install node${RESET}"
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"

if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ] 2>/dev/null; then
  die "Found Node v${NODE_VERSION}, but purmemo needs v${NODE_MIN_MAJOR} or newer.
  Upgrade from https://nodejs.org/en/download and re-run this command."
fi

ok "Node v${NODE_VERSION} detected."

# --- step 2: detect npm ------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  die "npm is not on your PATH. Reinstall Node.js from https://nodejs.org/en/download"
fi

# --- step 3: install ---------------------------------------------------------
step "Installing ${PKG}…"

# Some Node setups (e.g. system-managed Node on Linux) put npm's global prefix
# in a root-owned directory. Detect that and use sudo when needed.
NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo '')"
SUDO=""
if [ -n "$NPM_PREFIX" ] && [ ! -w "$NPM_PREFIX" ]; then
  if command -v sudo >/dev/null 2>&1; then
    warn "npm's global prefix (${NPM_PREFIX}) is not writable. Using sudo."
    SUDO="sudo"
  else
    die "npm's global prefix (${NPM_PREFIX}) is not writable and sudo is not available.
  Configure a user-writable prefix (e.g. https://docs.npmjs.com/resolving-eacces-permissions-errors)
  and re-run this command."
  fi
fi

# shellcheck disable=SC2086
$SUDO npm install -g "$PKG" --silent || die "npm install failed. See output above."

ok "${PKG} installed."

# --- step 4: verify ----------------------------------------------------------
step "Verifying ${BIN} is on your PATH…"

if ! command -v "$BIN" >/dev/null 2>&1; then
  warn "${BIN} was installed but is not on your PATH yet."
  say ""
  say "npm installed it under: ${NPM_PREFIX}/bin"
  say ""
  say "Add that directory to your PATH and reload your shell. For example:"
  say "  ${BOLD}echo 'export PATH=\"${NPM_PREFIX}/bin:\$PATH\"' >> ~/.zshrc${RESET}"
  say "  ${BOLD}source ~/.zshrc${RESET}"
  exit 1
fi

INSTALLED_VERSION="$(npm ls -g "$PKG" --depth=0 2>/dev/null | sed -n "s/.*${PKG}@\([0-9][^ ]*\).*/\1/p")"
if [ -n "$INSTALLED_VERSION" ]; then
  ok "${BIN} v${INSTALLED_VERSION} is ready."
else
  ok "${BIN} is ready."
fi

# --- done --------------------------------------------------------------------
say ""
say "${GREEN}${BOLD}You're set.${RESET}"
say ""
say "Next steps:"
say "  ${BOLD}purmemo${RESET}              ${DIM}— sign in and connect Claude${RESET}"
say "  ${BOLD}purmemo accounts${RESET}     ${DIM}— manage multiple accounts${RESET}"
say "  ${BOLD}purmemo --update${RESET}     ${DIM}— upgrade later${RESET}"
say ""
say "${DIM}Docs: https://purmemo.ai/docs${RESET}"
say ""
