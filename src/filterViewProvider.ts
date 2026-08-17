import * as vscode from 'vscode';
import { ChatHistoryProvider } from './chatHistoryProvider';
import { FilterState, FilterMode } from './filterState';
import { formatTokens, formatAic, formatUsd, computeUsd } from './modelPricing';

export class FilterViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'githubCopilotReport.filterView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly chatHistoryProvider: ChatHistoryProvider,
        private readonly filterState: FilterState
    ) {
        // Re-push stats whenever the filter changes.
        this.filterState.onDidChange(() => this.updateFilterStats());
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'setFilter':
                    this.filterState.setMode(data.mode as FilterMode);
                    break;
                case 'setCustomRange':
                    this.filterState.setCustomRange(data.start, data.end);
                    break;
                case 'setPickedMonth':
                    this.filterState.setPickedMonth(data.year, data.month);
                    break;
                case 'export':
                    vscode.commands.executeCommand('githubCopilotReport.exportExcel');
                    break;
                case 'copy':
                    vscode.commands.executeCommand('githubCopilotReport.copyToClipboard');
                    break;
                case 'ready':
                    this.updateFilterStats();
                    break;
            }
        });

        this.updateFilterStats();
    }

    /** Push the current filter mode + aggregate stats to the webview. */
    public updateFilterStats(): void {
        if (!this._view) { return; }
        const range = this.filterState.range;
        const s = this.chatHistoryProvider.getRangeSummary(range.start, range.end);
        this._view.webview.postMessage({
            type: 'filterStats',
            mode: range.mode,
            label: range.label,
            chats: s.chats,
            prompts: s.prompts,
            tokens: formatTokens(s.input + s.output),
            aic: formatAic(s.aic) + (s.aicComplete ? '' : '+'),
            usd: formatUsd(computeUsd(s.aic)) + (s.aicComplete ? '' : '+')
        });
    }

    private _getHtmlForWebview(): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Filter</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-sideBar-background);
        padding: 10px;
    }
    .filter-bar { display: flex; gap: 6px; margin-bottom: 8px; align-items: stretch; }
    .filter-select {
        flex: 1; padding: 6px 8px; border-radius: 4px;
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border));
        background: var(--vscode-dropdown-background, var(--vscode-input-background));
        color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
        font-size: 12px; cursor: pointer;
    }
    .custom-filter-bar { display: none; gap: 6px; margin-bottom: 8px; align-items: center; }
    .custom-filter-bar.visible { display: flex; }
    .date-input, .month-input, .year-input {
        padding: 5px 6px; border-radius: 4px;
        border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        font-size: 12px;
    }
    .date-input { flex: 1; min-width: 0; }
    .month-input { flex: 1.4; min-width: 0; }
    .year-input { flex: 0.8; min-width: 0; }
    .range-sep { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .apply-btn {
        padding: 5px 10px; border: none; border-radius: 4px;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        cursor: pointer; font-size: 12px; white-space: nowrap;
    }
    .apply-btn:hover { background: var(--vscode-button-hoverBackground); }
    .export-btn {
        display: flex; align-items: center; gap: 6px; justify-content: center;
        padding: 6px 10px; border: none; border-radius: 4px;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        cursor: pointer; font-size: 12px; white-space: nowrap;
    }
    .export-btn:hover { background: var(--vscode-button-hoverBackground); }
    .copy-btn {
        display: flex; align-items: center; gap: 5px; justify-content: center;
        padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap;
        background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-button-border, var(--vscode-input-border));
    }
    .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    .stat-card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, transparent);
        border-radius: 6px; padding: 8px 10px; margin-bottom: 10px;
    }
    .stat-period { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .stat-grid { display: flex; gap: 10px; flex-wrap: wrap; }
    .stat { display: flex; flex-direction: column; }
    .stat .num { font-size: 15px; font-weight: 600; color: var(--vscode-foreground); }
    .stat .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); }
    .stat .num.aic { color: var(--vscode-charts-green, #4ec9b0); }
    .stat .num.usd { color: var(--vscode-charts-yellow, #d7ba7d); }
</style>
</head>
<body>
    <div class="filter-bar">
        <select class="filter-select" id="filterSelect" title="Time range">
            <option value="month">📅 This Month</option>
            <option value="today">📅 Today</option>
            <option value="yesterday">📅 Yesterday</option>
            <option value="week">🗓️ This Week</option>
            <option value="pickedMonth">🗓️ Pick Month…</option>
            <option value="range">📆 Custom Range…</option>
            <option value="all">♾️ All time</option>
        </select>
        <button class="copy-btn" id="copyBtn" title="Copy the filtered table to the clipboard (paste into Excel / Google Sheets)">📋 Copy</button>
        <button class="export-btn" id="exportBtn" title="Export the filtered data to an Excel file">⬇ Excel</button>
    </div>

    <div class="custom-filter-bar" id="rangeBar">
        <input type="date" class="date-input" id="rangeFrom" title="From date">
        <span class="range-sep">to</span>
        <input type="date" class="date-input" id="rangeTo" title="To date">
        <button class="apply-btn" id="applyRangeBtn">Apply</button>
    </div>

    <div class="custom-filter-bar" id="monthBar">
        <select class="month-input" id="monthSelect" title="Month"></select>
        <input type="number" class="year-input" id="yearInput" title="Year" min="2000" max="2100">
        <button class="apply-btn" id="applyMonthBtn">Apply</button>
    </div>

    <div class="stat-card">
        <div class="stat-period" id="statPeriod">Loading…</div>
        <div class="stat-grid">
            <div class="stat"><span class="num" id="statChats">–</span><span class="lbl">Chats</span></div>
            <div class="stat"><span class="num" id="statPrompts">–</span><span class="lbl">Prompts</span></div>
            <div class="stat"><span class="num" id="statTokens">–</span><span class="lbl">Tokens</span></div>
            <div class="stat"><span class="num aic" id="statAic">–</span><span class="lbl">AIC</span></div>
            <div class="stat"><span class="num usd" id="statUsd" title="Estimated cost — AIC × your usdPerAic rate (default 1 AIC = $0.01)">–</span><span class="lbl">USD (est.)</span></div>
        </div>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);

    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const rangeBar = $('rangeBar');
    const monthBar = $('monthBar');
    const monthSelect = $('monthSelect');
    const yearInput = $('yearInput');

    MONTH_NAMES.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = name;
        monthSelect.appendChild(opt);
    });

    function hideCustomBars() {
        rangeBar.classList.remove('visible');
        monthBar.classList.remove('visible');
    }

    $('filterSelect').addEventListener('change', e => {
        const mode = e.target.value;
        if (mode === 'range') {
            hideCustomBars();
            const today = new Date().toISOString().slice(0, 10);
            if (!$('rangeFrom').value) { $('rangeFrom').value = today; }
            if (!$('rangeTo').value) { $('rangeTo').value = today; }
            rangeBar.classList.add('visible');
            return;
        }
        if (mode === 'pickedMonth') {
            hideCustomBars();
            const now = new Date();
            monthSelect.value = String(now.getMonth());
            yearInput.value = String(now.getFullYear());
            monthBar.classList.add('visible');
            return;
        }
        hideCustomBars();
        vscode.postMessage({ type: 'setFilter', mode });
    });

    $('applyRangeBtn').addEventListener('click', () => {
        const fromVal = $('rangeFrom').value;
        const toVal = $('rangeTo').value;
        if (!fromVal || !toVal) { return; }
        const start = new Date(fromVal + 'T00:00:00').getTime();
        const end = new Date(toVal + 'T23:59:59.999').getTime();
        if (end < start) { return; }
        vscode.postMessage({ type: 'setCustomRange', start, end });
    });

    $('applyMonthBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'setPickedMonth', year: Number(yearInput.value), month: Number(monthSelect.value) });
    });

    $('exportBtn').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
    $('copyBtn').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));

    window.addEventListener('message', event => {
        const m = event.data;
        switch (m.type) {
            case 'filterStats':
                $('filterSelect').value = m.mode;
                hideCustomBars();
                if (m.mode === 'range') {
                    rangeBar.classList.add('visible');
                } else if (m.mode === 'pickedMonth') {
                    monthBar.classList.add('visible');
                }
                $('statPeriod').textContent = m.label;
                $('statChats').textContent = m.chats;
                $('statPrompts').textContent = m.prompts;
                $('statTokens').textContent = m.tokens;
                $('statAic').textContent = m.aic;
                $('statUsd').textContent = m.usd;
                break;
        }
    });

    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
