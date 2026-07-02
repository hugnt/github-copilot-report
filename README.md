# Github Copilot Report

A VS Code extension that turns your **local GitHub Copilot chat history** into a usage report — showing the **tokens and AIC (AI Credits) used next to every prompt**, letting you **filter by the current week or month**, and **exporting a detailed Excel workbook**.

Everything runs **100% locally**. No data ever leaves your machine.

> Built on top of the excellent [copilot-chat-history-search](https://github.com/jeevananthamp16/copilot-chat-history-search) by @jeevananthamp16, extended with token/AIC accounting, time filters and Excel export.

---

## Features

- **Sidebar activity-bar view** with two panels:
  - **Filter & Search** (webview) — time-range dropdown, live totals, and content/title search.
  - **Recent Chats** (tree) — your chats grouped by day, each prompt annotated with its usage.
- **Token / AIC per prompt.** Every user prompt shows a badge like `▲ 35k  ▼ 252  ·  10.9 AIC`:
  - `▲` input (prompt) tokens · `▼` output (completion) tokens · computed **AIC**.
- **Time filter.** Choose **This Week** (Mon–Sun) or **This Month** — *defaults to the current month*. There is also an **All time** option.
- **Excel export.** One click exports everything in the current filter to an `.xlsx` with a **Summary** sheet (totals, by-model, by-day) and a **Prompts** sheet (one row per prompt with tokens & AIC).
- **Copy to clipboard.** The **📋 Copy** button (left of Export) copies the filtered table as tab-separated text — paste it straight into Excel or Google Sheets.
- **Pick your columns.** On export you tick which fields to include. The necessary ones — *#, Session, Model, Prompt, AIC, Input/Output/Total Tokens, Date* — are pre-selected in that order; optional ones (Workspace, Response) are one click away. Your choice is remembered and shared by both Copy and Export.

## What is "AIC"?

GitHub Copilot's usage-based billing prices each model in **AICs (AI Credits) per 1,000,000 tokens**. For example Claude Sonnet 4.6 is recorded in the chat data as `In: 300 · Out: 1500 AICs/1M tokens`. The extension computes, per prompt:

```
AIC = inputTokens/1e6 * inputCost
    + outputTokens/1e6 * outputCost
    + cachedTokens/1e6 * cacheCost
```

Model prices are read **directly from your chat data** when present, so new models are picked up automatically. You can override or add prices in settings (see below). When a model's price is unknown, its AIC is shown as `—` and session/period totals are marked with a `+` (lower-bound).

## How it reads your data

The extension parses the Copilot chat session files VS Code stores locally:

```
%APPDATA%\Code\User\workspaceStorage\<id>\chatSessions\*.jsonl   (Windows)
~/Library/Application Support/Code/User/...                       (macOS)
~/.config/Code/User/...                                           (Linux)
```

Each `.jsonl` is a delta log; the extension reconstructs each request and joins it with the
result metadata (`promptTokens`, `outputTokens`, `resolvedModel`) that Copilot writes for it.

Session titles are read from `state.vscdb` when the `sqlite3` CLI is available; otherwise the
first prompt is used as the title. **Token/AIC data does not depend on sqlite3** — it comes
straight from the `.jsonl` files.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `githubCopilotReport.defaultFilter` | `month` | Time range applied on startup: `week`, `month`, or `all`. |
| `githubCopilotReport.storagePath` | `""` | Custom path to the VS Code `User` folder (for Insiders/portable). |
| `githubCopilotReport.maxResults` | `200` | Max search results. |
| `githubCopilotReport.fuzzyThreshold` | `0.4` | Fuzzy search threshold (0 = exact … 1 = anything). |
| `githubCopilotReport.modelPricing` | `{}` | Override/add AIC pricing, e.g. `{ "claude-sonnet-4.6": { "inputCost": 300, "outputCost": 1500, "cacheCost": 30 } }` (AIC per 1,000,000 tokens). |

## Usage

1. Open the **Copilot Report** icon in the activity bar.
2. Pick a time range in the dropdown (defaults to *This Month*).
3. Browse **Recent Chats**; expand a chat to see each prompt with its token/AIC badge.
4. Click the **⬇ Excel** button (or the export icon in the tree title bar) to save the report.

Keyboard: `Ctrl+Alt+H` (`Cmd+Alt+H` on macOS) to search.

## Development

```bash
npm install
npm run compile     # bundle to out/extension.js (esbuild)
npm run watch       # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host.

## License

MIT
