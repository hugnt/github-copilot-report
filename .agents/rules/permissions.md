# Allowed Operations & Permissions Guidance

This file documents the operations that are **expected and safe** for this project.
The agent should feel confident executing these without extra confirmation.

## Safe Shell Commands

The following commands are routine for this project and can be run freely:

### Node.js / npm
- `npm install`, `npm run compile`, `npm run watch`, `npm run package`
- `npm --version`, `npm view <package>`
- `node esbuild.js`, `node esbuild.js --production`
- `node -e '<inline script>'` — for quick verification or data inspection
- `npx tsc --noEmit -p tsconfig.json` — type checking

### Packaging
- `npx --yes @vscode/vsce package --allow-missing-repository`

### Cleanup
- Removing scratch files: `Remove-Item scratch_*.js`, `Remove-Item *.xlsx` (temp reports only)
- Removing old build artifacts: `Remove-Item -Recurse out`, `Remove-Item *.vsix`

### VS Code CLI
- `code --list-extensions` — list installed extensions
- `code --extensionDevelopmentPath=.` — launch extension in dev mode

### Git / GitHub CLI
- `gh api <endpoint>` — GitHub API calls via CLI
- Standard git commands (`git status`, `git log`, `git diff`, etc.)

## Approved External Domains

The agent may fetch content from these domains when needed:

| Domain | Purpose |
|---|---|
| `raw.githubusercontent.com` | Fetching raw files from GitHub repositories |
| `docs.github.com` | GitHub documentation reference |
| `api.github.com` | GitHub REST API |

## File Access Patterns

The agent may need to read files from these locations for analysis:

- **Project source**: `src/**/*.ts`, `package.json`, `tsconfig.json`, `esbuild.js`
- **Build output**: `out/**/*.js`
- **VS Code workspace storage**: The user's Copilot chat session data (paths vary by OS; ask the user if needed)

## Operations Requiring Confirmation

The following operations are **destructive or impactful** — always confirm with the user first:

- Modifying `package.json` version or dependencies
- Publishing the extension (`vsce publish`)
- Deleting any non-scratch files
- Running `npm install` with new packages not already in `package.json`
- Any command that modifies files outside the project root
