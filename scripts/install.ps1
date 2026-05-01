# purmemo installer — one-line install for Windows.
#
# Usage:
#   irm https://purmemo.ai/install.ps1 | iex
#
# Or inspect first (recommended for the security-conscious):
#   irm https://purmemo.ai/install.ps1 -OutFile install.ps1
#   notepad install.ps1
#   .\install.ps1
#
# What this does:
#   1. Checks for Node.js >= 18.
#   2. If Node is missing, points you at the official installer.
#   3. Runs `npm i -g purmemo-mcp` to install the CLI.
#   4. Verifies `purmemo` is on your PATH and prints next steps.
#
# Source: https://github.com/purmemo-ai/purmemo-mcp/blob/main/scripts/install.ps1

$ErrorActionPreference = 'Stop'

$NodeMinMajor = 18
$Pkg = 'purmemo-mcp'
$Bin = 'purmemo'

function Write-Step($msg) { Write-Host "→ $msg" -ForegroundColor White }
function Write-Ok($msg)   { Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "! $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "✗ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "purmemo installer" -ForegroundColor White
Write-Host "AI memory + workflows for Claude. https://purmemo.ai" -ForegroundColor DarkGray
Write-Host ""

# --- step 1: detect Node ---------------------------------------------------
Write-Step "Checking for Node.js…"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn2 "Node.js is not installed."
    Write-Host ""
    Write-Host "purmemo runs on Node.js (>= v$NodeMinMajor). Install it from the official"
    Write-Host "installer, then re-run this command:"
    Write-Host ""
    Write-Host "  https://nodejs.org/en/download" -ForegroundColor White
    Write-Host ""
    Write-Host "On Windows with winget you can also run: winget install OpenJS.NodeJS.LTS"
    exit 1
}

$nodeVersionRaw = & node --version 2>$null
$nodeVersion = $nodeVersionRaw.TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])

if ($nodeMajor -lt $NodeMinMajor) {
    Write-Err2 "Found Node v$nodeVersion, but purmemo needs v$NodeMinMajor or newer."
    Write-Host "  Upgrade from https://nodejs.org/en/download and re-run this command."
    exit 1
}

Write-Ok "Node v$nodeVersion detected."

# --- step 2: detect npm ----------------------------------------------------
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Err2 "npm is not on your PATH. Reinstall Node.js from https://nodejs.org/en/download"
    exit 1
}

# --- step 3: install -------------------------------------------------------
Write-Step "Installing $Pkg…"

# On Windows the global prefix is usually under the user's AppData, so writable.
# We don't try to elevate; if the user has an unusual setup they'll get a clear
# error from npm itself.
& npm install -g $Pkg --silent
if ($LASTEXITCODE -ne 0) {
    Write-Err2 "npm install failed. See output above."
    exit 1
}

Write-Ok "$Pkg installed."

# --- step 4: verify --------------------------------------------------------
Write-Step "Verifying $Bin is on your PATH…"

# PowerShell sessions cache PATH lookups; refresh from the registry so a fresh
# install in the same session is found.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')

$binCmd = Get-Command $Bin -ErrorAction SilentlyContinue
if (-not $binCmd) {
    $npmPrefix = (& npm config get prefix).Trim()
    Write-Warn2 "$Bin was installed but is not on your PATH yet."
    Write-Host ""
    Write-Host "npm installed it under: $npmPrefix"
    Write-Host ""
    Write-Host "Open a new PowerShell window and try again. If it still isn't found, add"
    Write-Host "the npm prefix above to your User PATH environment variable."
    exit 1
}

$lsOutput = (& npm ls -g $Pkg --depth=0 2>$null) -join "`n"
$installedVersion = ''
if ($lsOutput -match "$Pkg@([0-9][^\s]*)") { $installedVersion = $Matches[1] }
if ($installedVersion) {
    Write-Ok "$Bin v$installedVersion is ready."
} else {
    Write-Ok "$Bin is ready."
}

# --- done ------------------------------------------------------------------
Write-Host ""
Write-Host "You're set." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  purmemo              " -NoNewline -ForegroundColor White
Write-Host "— sign in and connect Claude" -ForegroundColor DarkGray
Write-Host "  purmemo accounts     " -NoNewline -ForegroundColor White
Write-Host "— manage multiple accounts" -ForegroundColor DarkGray
Write-Host "  purmemo --update     " -NoNewline -ForegroundColor White
Write-Host "— upgrade later" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Docs: https://purmemo.ai/docs" -ForegroundColor DarkGray
Write-Host ""
