---
name: vscode-extension-dev
description: >-
  Use this skill when the user asks to build, compile, test, package, or
  troubleshoot the github-copilot-report VS Code extension. Covers the full
  development lifecycle from code change to VSIX packaging.
---

# VS Code Extension Development Workflow

This skill provides step-by-step instructions for the complete build-test-package
cycle of the `github-copilot-report` VS Code extension.

## Prerequisites

- Node.js (LTS) and npm installed
- VS Code installed (for extension development host testing)

## Workflow Steps

### 1. Install Dependencies

```bash
npm install
```

Only needed on first clone or when `package.json` changes.

### 2. Compile (Development)

```bash
npm run compile
# or equivalently:
node esbuild.js
```

This produces `out/extension.js` — the bundled extension entry point.

### 3. Type Check

```bash
npx tsc --noEmit -p tsconfig.json
```

> **Important**: Always run this before packaging. esbuild does not perform type
> checking, so TypeScript errors will silently pass the compile step.

### 4. Watch Mode (for active development)

```bash
npm run watch
```

Automatically rebuilds on file changes. Use this during active development.

### 5. Test with Scratch Scripts

For quick verification without the full VS Code extension host:

```bash
node scratch_verify.js    # one-off test script
node scratch_smoke.js     # smoke test
```

Clean up after testing:

```powershell
Remove-Item -Force scratch_*.js, scratch_*.xlsx
```

### 6. Production Build

```bash
node esbuild.js --production
```

Enables minification and tree-shaking for a smaller bundle.

### 7. Package as VSIX

```bash
npx --yes @vscode/vsce package --allow-missing-repository
```

This creates a `github-copilot-report-<version>.vsix` file in the project root.

### 8. Clean Build (when needed)

```powershell
Remove-Item -Recurse -Force out
Remove-Item -Force github-copilot-report-*.vsix
npm run compile
```

## Troubleshooting

| Problem | Solution |
|---|---|
| Type errors not caught during compile | Run `npx tsc --noEmit` separately — esbuild skips type checking |
| `vsce package` fails | Check that `package.json` has valid `name`, `version`, `publisher`, and `engines.vscode` |
| Extension doesn't activate | Verify `activationEvents` in `package.json` and check the developer console (`Help > Toggle Developer Tools`) |
| Module not found at runtime | Ensure the dependency is in `dependencies` (not `devDependencies`) and esbuild bundles it (check `external` config in `esbuild.js`) |

## Version Bumping Checklist

1. Update `version` in `package.json`
2. Run type check: `npx tsc --noEmit -p tsconfig.json`
3. Production build: `node esbuild.js --production`
4. Package: `npx --yes @vscode/vsce package --allow-missing-repository`
5. Clean up old VSIX files
