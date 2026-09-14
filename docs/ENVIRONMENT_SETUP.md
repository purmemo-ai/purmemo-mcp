# Environment Setup Guide

## Quick Start

1. **Copy the example file:**
   ```bash
   cp .env.example .env
   ```

2. **Fill in your tokens** in `.env` (already done if you're the maintainer)

3. **Load environment variables:**
   ```bash
   source scripts/load-env.sh
   ```

## Available Tokens

### NPM Publishing
- **`NPM_TOKEN`** - Primary granular token (expires March 10, 2026)
  - Used for automated npm publishing
  - Required for: `npm publish`, GitHub Actions
  - Get from: https://www.npmjs.com/settings/YOUR_USERNAME/tokens

- **`NPM_TOKEN_LEGACY`** - Classic token (expires February 23, 2026)
  - Used for legacy compatibility
  - Stored in `~/.npmrc` for global npm commands

### Purmemo API
- **`PURMEMO_API_KEY`** - API key for testing MCP server
  - Required for: Local MCP server testing
  - Get from: https://app.purmemo.ai/settings

### GitHub (Optional)
- **`GITHUB_TOKEN`** - Personal access token
  - Used for: `gh` CLI commands
  - Get from: https://github.com/settings/tokens
  - Note: Usually handled by `gh auth login`

### Render (Optional)
- **`RENDER_API_KEY`** - Render deployment token
  - Used for: Render MCP server tools
  - Get from: https://dashboard.render.com/account/settings

### Supabase (Optional)
- **`SUPABASE_ACCESS_TOKEN`** - Supabase API token
  - Used for: Supabase MCP server tools
  - Get from: https://app.supabase.com/account/tokens

## Usage Examples

### Publishing to npm
```bash
# Load environment
source scripts/load-env.sh

# Publish with token from .env
npm publish --access public
```

### Using with GitHub Actions
Tokens are automatically loaded from repository secrets:
- `NPM_TOKEN` → Set via `gh secret set NPM_TOKEN`
- Used by `.github/workflows/publish.yml`

### Testing MCP Server Locally
```bash
# Load environment
source scripts/load-env.sh

# Run server with API key
npm start
```

## Security Notes

1. **Never commit `.env`** - It's in `.gitignore`
2. **Rotate tokens regularly** - Check expiration dates
3. **Use granular tokens** - Prefer scoped tokens over classic tokens
4. **Store backups securely** - Use password manager for token backup

## Token Expiration Dates

| Token | Expires | Action Needed |
|-------|---------|---------------|
| NPM_TOKEN | March 10, 2026 | Regenerate before expiry |
| NPM_TOKEN_LEGACY | February 23, 2026 | Regenerate before expiry |
| PURMEMO_API_KEY | N/A | Managed at app.purmemo.ai |

## Troubleshooting

### "npm publish" fails with auth error
1. Check `NPM_TOKEN` is set: `echo $NPM_TOKEN`
2. Verify token hasn't expired
3. Regenerate at https://www.npmjs.com/settings/tokens

### GitHub Actions publish fails
A `404 Not Found - PUT https://registry.npmjs.org/purmemo-mcp` on publish means the token was rejected (npm hides auth failures as 404). Granular tokens live at most 90 days.
1. Verify secret is set: `gh secret list -R purmemo-ai/purmemo-mcp` (the date shown is when it was set; +90 days is the latest it can still work)
2. Preferred fix (no more expiry): on npmjs.com → package purmemo-mcp → Settings → Trusted Publisher → GitHub Actions, org `purmemo-ai`, repo `purmemo-mcp`, workflow `publish.yml`. Then delete the `NPM_TOKEN` secret; the workflow already upgrades npm and publishes with `--provenance` via OIDC.
3. Token fix (recurs every 90 days): mint a granular token with publish rights + bypass 2FA, then `echo "YOUR_TOKEN" | gh secret set NPM_TOKEN -R purmemo-ai/purmemo-mcp`
4. Re-run the failed publish job: `gh run rerun <run-id> -R purmemo-ai/purmemo-mcp` (the .mcpb upload rides on the same job)

### MCP server can't connect to API
1. Check `PURMEMO_API_KEY` is set
2. Verify key is valid at https://app.purmemo.ai/settings
3. Test connection: `curl -H "Authorization: Bearer $PURMEMO_API_KEY" https://api.purmemo.ai/health`
