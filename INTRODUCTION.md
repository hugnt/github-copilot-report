# Github Copilot Report — Introduction & Guide

## 1. Introduction

**Github Copilot Report** is a VS Code extension that turns your **local GitHub Copilot chat history** into a usage report: it shows the **tokens and AIC (AI Credits) used right next to every prompt**, lets you **filter by the current week/month**, and **exports a detailed Excel report**.

Everything runs **100% locally on your machine** — no data ever leaves it.

This extension is **built on top of two open-source projects**:

- **[copilot-chat-history-search](https://github.com/jeevananthamp16/copilot-chat-history-search)** by [@jeevananthamp16](https://github.com/jeevananthamp16) — the foundation for reading and searching the Copilot chat session files VS Code stores locally.
- **[github-copilot-chat-usage](https://github.com/ailmind/github-copilot-chat-usage)** by [@ailmind](https://github.com/ailmind) — the AIC/USD accounting model (actual billed credits, not an estimate).

### Installation

**Option 1 — Install from the VS Code Marketplace (inside VS Code):**

1. Open the **Extensions** panel (`Ctrl+Shift+X`).
2. Search for **"Github Copilot Report"**.
3. Click **Install** on the matching result.

**Option 2 — Install from a `.vsix` file** (a prebuilt package included in the repo, e.g. `github-copilot-report-1.3.2.vsix`):

```bash
code --install-extension github-copilot-report-1.3.2.vsix
```

Or in VS Code: open the **Extensions** panel → `...` menu → **Install from VSIX...** → pick the `.vsix` file.

### Usage

<p align="center">
  <img src="media/screenshots/sidebar.png" alt="Copilot Report sidebar — time filter, live Chats / Prompts / Tokens / AIC / USD totals, and Recent Chats grouped by day with a token · AIC · $ badge on every prompt" width="420">
</p>

_The sidebar: pick a time range, read the live **Chats · Prompts · Tokens · AIC · USD** totals, and browse **Recent Chats** where every prompt is annotated with its usage._

1. Open the **Copilot Report** icon in the activity bar (the icon strip on the left).
2. Pick a time range in the **Filter & Search** dropdown (defaults to *This Month*).
3. Browse **Recent Chats**; expand a chat to see each prompt with its token/AIC badge.
4. Click the **⬇ Excel** button (or the export icon in the tree title bar) to export the report.

Keyboard shortcut: `Ctrl+Alt+H` (`Cmd+Alt+H` on macOS) to open search.

---

## 2. Details

### Problem

GitHub Copilot Chat doesn't give users clear visibility into:

- **Actual cost incurred** — Copilot bills usage-based plans in AIC (AI Credits), but there's no UI showing how many credits were charged per prompt or per chat session.
- **Old chat history** — chat history is scattered across `.jsonl` files per workspace, making it hard to find a specific conversation by time or content.
- **Aggregate reporting** — there's no way to roll up usage by week/month or by model, or to export it for cost tracking/reporting.

### Solution

This extension combines two open-source extensions, each of which had already solved half the problem, and adds the missing piece on top:

- **[copilot-chat-history-search](https://github.com/jeevananthamp16/copilot-chat-history-search)** solved **retrieving chat history**: it reads and parses the `.jsonl` chat session files VS Code stores locally, reconstructs each request/response, and lets you search by content/title.
- **[github-copilot-chat-usage](https://github.com/ailmind/github-copilot-chat-usage)** solved **extracting the actual usage figures (AIC)**: it reads the exact credit amount Copilot billed for each request (`nanoAiu` / `copilotUsageNanoAiu`, or the `"X credits"` text in `result.details`) — no token × price-guess formula, so the numbers match exactly what GitHub actually charges.

On top of those two pieces, **Github Copilot Report** adds: time-range filtering (week/month/all), token/AIC/USD badges on every prompt, and Excel export / clipboard copy.

#### How it reads your data

The extension reads the Copilot chat session files VS Code stores locally:

```
%APPDATA%\Code\User\workspaceStorage\<id>\chatSessions\*.jsonl   (Windows)
~/Library/Application Support/Code/User/...                       (macOS)
~/.config/Code/User/...                                           (Linux)
```

Each `.jsonl` file is a delta log; the extension reconstructs each request and joins it with the result metadata (`promptTokens`, `outputTokens`, `resolvedModel`) Copilot writes for it.

Session titles are read from `state.vscdb` when the `sqlite3` CLI is available; otherwise the first prompt is used as the title. **Token/AIC data does not depend on sqlite3** — it comes straight from the `.jsonl` files.

AIC per prompt is read in this priority order:

1. The `nanoAiu` field (a.k.a. `copilotUsageNanoAiu`) Copilot writes once it has billed the request: `AIC = nanoAiu / 1e9`.
2. If that field isn't present yet, the text line Copilot writes into `result.details` once billing is reconciled — e.g. `"Raptor mini • 2.0 credits"` — is parsed for the credit amount.

If neither is present, that prompt's AIC/USD is shown as `—` (unknown) rather than a guess, and the session/period total is marked with a `+` to flag it as a lower bound.

The USD estimate uses GitHub's fixed rate: `1 AI credit = $0.01 USD` (`USD = AIC × usdPerAic`, `usdPerAic` defaults to `0.01`, adjustable via the `githubCopilotReport.usdPerAic` setting).

#### Features

- **Sidebar activity-bar view** with two panels:
  - **Filter & Search** (webview) — time-range dropdown, live totals, content/title search.
  - **Recent Chats** (tree) — chats grouped by day, each prompt annotated with its usage.
- **Token / AIC / USD per prompt.** Every prompt shows a badge like `▲ 35k  ▼ 252  ·  10.9 AIC  ·  $0.11`: `▲` input (prompt) tokens · `▼` output (completion) tokens · **AIC** · estimated **USD** cost.
- **Time filter.** Choose **This Week** (Mon–Sun) or **This Month** (*defaults to the current month*), or **All time**.
- **Excel export.** One click exports everything in the current filter to an `.xlsx` with a **Summary** sheet (totals, by model, by day) and a **Prompts** sheet (one row per prompt with tokens & AIC).
- **Copy to clipboard.** The **📋 Copy** button (left of Export) copies the filtered table as tab-separated text — paste straight into Excel or Google Sheets.
- **Pick your columns on export.** You tick which fields to include; the necessary ones (*#, Session, Model, Prompt, AIC, USD, Input/Output/Total Tokens, Date*) are pre-selected in that order, and optional ones (Workspace, Response) are one click away. Your choice is remembered and shared by both Copy and Export.

---

## 3. Acknowledgments

This extension is built on two open-source projects — thank you 🙏:

- **[copilot-chat-history-search](https://github.com/jeevananthamp16/copilot-chat-history-search)** by [@jeevananthamp16](https://github.com/jeevananthamp16) — the foundation for reading and searching VS Code's local Copilot chat session files.
- **[github-copilot-chat-usage](https://github.com/ailmind/github-copilot-chat-usage)** by [@ailmind](https://github.com/ailmind) — the AIC/USD accounting (`extractNanoAiu()` in [src/chatHistoryProvider.ts](src/chatHistoryProvider.ts)) mirrors that project's credit extraction logic, with no token × price estimate involved.

The chat-history search & parsing come from the first project; the AIC → USD accounting is a direct port of the second. Github Copilot Report combines the two and adds time filters, per-prompt token/AIC/USD badges, and Excel export.
