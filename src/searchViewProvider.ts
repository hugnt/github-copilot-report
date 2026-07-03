import * as vscode from 'vscode';
import { ChatHistoryProvider, ChatMessage } from './chatHistoryProvider';
import { FilterState, FilterMode } from './filterState';
import { formatTokens, formatAic, formatUsd, computeUsd } from './modelPricing';

export class SearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'githubCopilotReport.searchView';

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
                case 'search': {
                    const results = this.chatHistoryProvider.search(data.query);
                    this.updateResults(results, data.query);
                    break;
                }
                case 'titleSearch': {
                    const sessions = this.chatHistoryProvider.searchSessionsByTitle(data.query);
                    this.updateSessionResults(sessions, data.query);
                    break;
                }
                case 'openMessage':
                    vscode.commands.executeCommand('githubCopilotReport.openChat', data.message);
                    break;
                case 'openSession':
                    vscode.commands.executeCommand('githubCopilotReport.openSession', data.session);
                    break;
                case 'refresh':
                    await vscode.commands.executeCommand('githubCopilotReport.refresh');
                    break;
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

    public updateResults(results: ChatMessage[], query: string): void {
        this._view?.webview.postMessage({ type: 'results', results, query });
    }

    public updateSessionResults(sessions: any[], query: string): void {
        this._view?.webview.postMessage({ type: 'sessionResults', sessions, query });
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
<title>Copilot Report</title>
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
    .search-type-toggle { display: flex; margin-bottom: 6px; gap: 4px; }
    .search-type-btn {
        flex: 1; padding: 4px 8px; font-size: 11px;
        border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background); color: var(--vscode-foreground);
        cursor: pointer; border-radius: 3px;
    }
    .search-type-btn.active {
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
    }
    .search-input {
        width: 100%; padding: 8px 12px; border-radius: 4px;
        border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        font-size: 13px; margin-bottom: 8px;
    }
    .search-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
    .row-actions { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .refresh-btn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; }
    .refresh-btn:hover { text-decoration: underline; }
    .results-header { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
    .result-item { padding: 10px; margin-bottom: 8px; background: var(--vscode-editor-background); border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
    .result-item:hover { border-color: var(--vscode-focusBorder); }
    .result-role { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .result-role.user { color: var(--vscode-charts-blue); }
    .result-role.assistant { color: var(--vscode-charts-green); }
    .result-content { font-size: 12px; line-height: 1.5; word-break: break-word; }
    .result-content mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; padding: 1px 2px; border-radius: 2px; }
    .result-time { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
    .session-result { padding: 8px; margin-bottom: 6px; background: var(--vscode-list-hoverBackground); border-radius: 4px; cursor: pointer; }
    .session-result:hover { background: var(--vscode-list-activeSelectionBackground); }
    .session-title { font-weight: 500; margin-bottom: 4px; }
    .session-meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .no-results, .hint, .loading { text-align: center; padding: 16px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .no-results-icon { font-size: 28px; margin-bottom: 6px; }
</style>
</head>
<body>
    <div class="filter-bar">
        <select class="filter-select" id="filterSelect" title="Time range">
            <option value="month">📅 This Month</option>
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

    <div class="search-type-toggle">
        <button class="search-type-btn active" id="contentSearchBtn">Content</button>
        <button class="search-type-btn" id="titleSearchBtn">Session Title</button>
    </div>

    <input type="text" class="search-input" id="searchInput" placeholder="Search chat content…">

    <div class="row-actions">
        <span style="font-size:11px;color:var(--vscode-descriptionForeground)">Ctrl/Cmd+Alt+H to search</span>
        <button class="refresh-btn" id="refreshBtn">↻ Refresh</button>
    </div>

    <div id="resultsContainer">
        <div class="hint">Pick a time range above, then browse the tree below or search here.</div>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const searchInput = $('searchInput');
    const resultsContainer = $('resultsContainer');
    const contentBtn = $('contentSearchBtn');
    const titleBtn = $('titleSearchBtn');
    let debounceTimer; let searchType = 'content';

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
    $('refreshBtn').addEventListener('click', () => {
        $('statPeriod').textContent = 'Refreshing…';
        vscode.postMessage({ type: 'refresh' });
    });

    contentBtn.addEventListener('click', () => {
        searchType = 'content'; contentBtn.classList.add('active'); titleBtn.classList.remove('active');
        searchInput.placeholder = 'Search chat content…'; searchInput.value = '';
        resultsContainer.innerHTML = '<div class="hint">Type to search chat content.</div>';
    });
    titleBtn.addEventListener('click', () => {
        searchType = 'title'; titleBtn.classList.add('active'); contentBtn.classList.remove('active');
        searchInput.placeholder = 'Search session titles…'; searchInput.value = '';
        resultsContainer.innerHTML = '<div class="hint">Type to search session titles.</div>';
    });

    searchInput.addEventListener('input', e => {
        clearTimeout(debounceTimer);
        const query = e.target.value.trim();
        if (query.length < 2) {
            resultsContainer.innerHTML = '<div class="hint">Type at least 2 characters to search.</div>';
            return;
        }
        resultsContainer.innerHTML = '<div class="loading">Searching…</div>';
        debounceTimer = setTimeout(() => {
            vscode.postMessage({ type: searchType === 'title' ? 'titleSearch' : 'search', query });
        }, 300);
    });

    window.addEventListener('message', event => {
        const m = event.data;
        switch (m.type) {
            case 'filterStats':
                $('filterSelect').value = m.mode;
                hideCustomBars();
                $('statPeriod').textContent = m.label;
                $('statChats').textContent = m.chats;
                $('statPrompts').textContent = m.prompts;
                $('statTokens').textContent = m.tokens;
                $('statAic').textContent = m.aic;
                $('statUsd').textContent = m.usd;
                break;
            case 'results': displayResults(m.results, m.query); break;
            case 'sessionResults': displaySessionResults(m.sessions, m.query); break;
        }
    });

    function displayResults(results, query) {
        if (!results.length) {
            resultsContainer.innerHTML = '<div class="no-results"><div class="no-results-icon">🔍</div><div>No results for "' + escapeHtml(query) + '"</div></div>';
            return;
        }
        resultsContainer.innerHTML = '<div class="results-header">' + results.length + ' result' + (results.length === 1 ? '' : 's') + '</div>';
        results.forEach(result => {
            const div = document.createElement('div');
            div.className = 'result-item';
            div.innerHTML =
                '<div class="result-role ' + result.role + '">' + result.role + '</div>' +
                '<div class="result-content">' + highlight(result.preview || result.content.substring(0, 300), query) + '</div>' +
                '<div class="result-time">' + formatTime(result.timestamp) + '</div>';
            div.addEventListener('click', () => vscode.postMessage({ type: 'openMessage', message: result }));
            resultsContainer.appendChild(div);
        });
    }

    function displaySessionResults(sessions, query) {
        if (!sessions.length) {
            resultsContainer.innerHTML = '<div class="no-results"><div class="no-results-icon">📁</div><div>No sessions matching "' + escapeHtml(query) + '"</div></div>';
            return;
        }
        resultsContainer.innerHTML = '<div class="results-header">' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + '</div>';
        sessions.forEach(session => {
            const div = document.createElement('div');
            div.className = 'session-result';
            const msgCount = session.messages ? session.messages.length : 0;
            div.innerHTML =
                '<div class="session-title">' + highlight(session.title, query) + '</div>' +
                '<div class="session-meta">' + msgCount + ' message' + (msgCount === 1 ? '' : 's') + ' • ' + formatTime(session.timestamp) + '</div>';
            div.addEventListener('click', () => vscode.postMessage({ type: 'openSession', session }));
            resultsContainer.appendChild(div);
        });
    }

    function highlight(text, query) {
        const escaped = escapeHtml(text);
        try {
            const regex = new RegExp('(' + query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
            return escaped.replace(regex, '<mark>$1</mark>');
        } catch { return escaped; }
    }
    function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text == null ? '' : text; return d.innerHTML; }
    function formatTime(ts) {
        const date = new Date(ts); const now = new Date();
        if (date.toDateString() === now.toDateString()) {
            return 'Today ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

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
