import * as vscode from 'vscode';
import { ChatHistoryProvider, ChatMessage } from './chatHistoryProvider';

export class SearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'githubCopilotReport.searchView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly chatHistoryProvider: ChatHistoryProvider
    ) {
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
            }
        });
    }

    public updateResults(results: ChatMessage[], query: string): void {
        this._view?.webview.postMessage({ type: 'results', results, query });
    }

    public updateSessionResults(sessions: any[], query: string): void {
        this._view?.webview.postMessage({ type: 'sessionResults', sessions, query });
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
        <div class="hint">Search for chats or sessions above.</div>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const searchInput = $('searchInput');
    const resultsContainer = $('resultsContainer');
    const contentBtn = $('contentSearchBtn');
    const titleBtn = $('titleSearchBtn');
    let debounceTimer; let searchType = 'content';

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
