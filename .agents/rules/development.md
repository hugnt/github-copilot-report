# Development Workflow Rules

## Build & Compile

- **Always type-check before packaging**: Run `npx tsc --noEmit -p tsconfig.json` before creating a `.vsix` bundle. esbuild skips type checking.
- **Use the project's esbuild config**: Compile with `node esbuild.js`, not raw `npx esbuild` with ad-hoc flags. The project's `esbuild.js` contains the correct entry points, externals, and platform settings.
- **Production builds**: Use `node esbuild.js --production` to enable minification and tree-shaking.

## Packaging

- Package with: `npx --yes @vscode/vsce package --allow-missing-repository`
- Always bump the `version` field in `package.json` before creating a new `.vsix`.
- Remove old `.vsix` files after a successful new package to avoid confusion.

## Dependency Management

- Install dependencies with `npm install`.
- Do not add dependencies that are not compatible with the VS Code extension host (e.g., native Node.js addons that require node-gyp).
- Keep `exceljs` and `fuse.js` as the only runtime dependencies unless a new feature explicitly requires a new package.

## Scratch & Temporary Files

- Scratch test files (e.g., `scratch_*.js`) are one-off verification scripts.
- Always clean up scratch files after use: `Remove-Item -Force scratch_*.js` (PowerShell) or equivalent.
- Never commit scratch files to version control.

## Code Quality

- TypeScript strict mode is enabled — do not use `any` unless absolutely necessary and document why.
- Run `npm run compile` to verify the bundle builds without errors after any code change.
- Ensure the extension activates cleanly — test with `code --extensionDevelopmentPath=.` when possible.
