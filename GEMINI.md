# GitHub Copilot Report — VS Code Extension

## Project Overview

This is a **VS Code extension** (`github-copilot-report`) that lets users browse their GitHub Copilot chat history with per-prompt token & AIC usage tracking, filter by week/month, and export detailed Excel reports.

- **Publisher**: `hugnt-vse`
- **Extension ID**: `github-copilot-report`
- **VS Code Engine**: `^1.85.0`

## Tech Stack

- **Language**: TypeScript (strict mode, targeting ES2020)
- **Build Tool**: esbuild (via `node esbuild.js`)
- **Bundler Config**: `esbuild.js` at project root
- **Package Manager**: npm
- **Key Dependencies**:
  - `exceljs` — Excel report generation
  - `fuse.js` — Fuzzy search
- **Dev Dependencies**: `@types/vscode`, `@types/node`, `typescript`, `esbuild`, `@vscode/vsce`

## Source Structure

```
src/
├── extension.ts             # Extension entry point & activation
├── chatHistoryProvider.ts   # Copilot chat history data provider
├── chatViewerPanel.ts       # Webview panel for viewing chats
├── excelExport.ts           # Excel export functionality
├── filterState.ts           # Time filter state management
├── historyTreeProvider.ts   # TreeView data provider for recent chats
├── modelPricing.ts          # AI model pricing/token cost calculations
└── searchViewProvider.ts    # Search webview provider
```

## Development Conventions

- All source files are in `src/` and compile to `out/`.
- Use the VS Code Extension API — do not import Node.js modules that are unavailable in the extension host unless absolutely necessary.
- Maintain existing JSDoc comments and inline documentation when editing files.
- Follow the existing code style: 2-space indentation, single quotes for strings in TypeScript.
- The extension activates on `onStartupFinished` — avoid heavy synchronous work in the `activate()` function.

## Build Commands

| Task | Command |
|---|---|
| Compile (dev) | `npm run compile` or `node esbuild.js` |
| Watch mode | `npm run watch` |
| Type check | `npx tsc --noEmit -p tsconfig.json` |
| Production build | `node esbuild.js --production` |
| Package VSIX | `npx --yes @vscode/vsce package --allow-missing-repository` |

## Important Notes

- The output bundle is a single `out/extension.js` file produced by esbuild.
- Always run `npx tsc --noEmit` before packaging to catch type errors — esbuild does not perform type checking.
- The `.vsix` file is the distributable artifact; version is managed in `package.json`.
