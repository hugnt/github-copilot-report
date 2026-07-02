import * as vscode from 'vscode';
import { ChatSession, ChatMessage } from './chatHistoryProvider';
import { formatTokens, formatAic, getModelDisplayName } from './modelPricing';

/** Build a small token / AIC badge for a prompt that has usage metadata. */
function usageBadge(msg: ChatMessage): string {
    const u = msg.usage;
    if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) {
        return '';
    }
    const model = getModelDisplayName(u.model);
    const title = `Model: ${model} · Input: ${(u.inputTokens ?? 0).toLocaleString()} · Output: ${(u.outputTokens ?? 0).toLocaleString()} tokens`;
    return `<span class="usage-badge" title="${title.replace(/"/g, '&quot;')}">`
        + `▲ ${formatTokens(u.inputTokens)} &nbsp; ▼ ${formatTokens(u.outputTokens)} &nbsp; · &nbsp; ${formatAic(u.aic)} AIC</span>`;
}

/**
 * WebView Panel that displays chat sessions in a VS Code-like chat interface
 * - Chat bubble style messages
 * - Mermaid diagram rendering (properly rendered)
 * - Syntax highlighted code blocks
 * - Clickable file links with line numbers
 * - Tables support
 * - "Open in Copilot Chat" button
 */
export class ChatViewerPanel {
    public static currentPanel: ChatViewerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _currentSession: ChatSession | undefined;

    private constructor(panel: vscode.WebviewPanel, session: ChatSession, highlightMessage?: ChatMessage, highlightMessageIndex?: number) {
        this._panel = panel;
        this._currentSession = session;
        this._panel.webview.html = this._getHtmlContent(session, highlightMessage, highlightMessageIndex);
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        
        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'openFile':
                        this._openFile(message.path, message.lineNumber);
                        break;
                    case 'copyCode':
                        vscode.env.clipboard.writeText(message.code);
                        vscode.window.showInformationMessage('Code copied to clipboard');
                        break;
                    case 'openInCopilot':
                        await this._tryOpenInCopilotChat();
                        break;
                    case 'copySessionId':
                        if (this._currentSession?.id) {
                            await vscode.env.clipboard.writeText(this._currentSession.id);
                            vscode.window.showInformationMessage('Session ID copied to clipboard');
                        }
                        break;
                    case 'copyMessage':
                        if (message.content) {
                            await vscode.env.clipboard.writeText(message.content);
                            vscode.window.showInformationMessage(`Message ${message.index + 1} copied to clipboard`);
                        }
                        break;
                    case 'exportMessage':
                        if (message.content) {
                            const markdown = `## ${message.role === 'user' ? 'User' : 'Assistant'} (${message.timestamp})\n\n${message.content}`;
                            const uri = await vscode.window.showSaveDialog({
                                defaultUri: vscode.Uri.file(`message_${message.index + 1}.md`),
                                filters: { 'Markdown': ['md'], 'Text': ['txt'] }
                            });
                            if (uri) {
                                await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf8'));
                                vscode.window.showInformationMessage(`Message exported to ${uri.fsPath}`);
                            }
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public static show(session: ChatSession, highlightMessage?: ChatMessage, highlightMessageIndex?: number) {
        const column = vscode.ViewColumn.Beside;

        // Calculate message index if not provided
        if (highlightMessage && highlightMessageIndex === undefined) {
            highlightMessageIndex = session.messages.findIndex(m => 
                m.content === highlightMessage.content && m.timestamp === highlightMessage.timestamp
            );
        }

        if (ChatViewerPanel.currentPanel) {
            ChatViewerPanel.currentPanel._panel.reveal(column);
            ChatViewerPanel.currentPanel._currentSession = session;
            ChatViewerPanel.currentPanel._panel.webview.html = 
                ChatViewerPanel.currentPanel._getHtmlContent(session, highlightMessage, highlightMessageIndex);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'copilotChatViewer',
            `Chat: ${session.title || 'Session'}`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        ChatViewerPanel.currentPanel = new ChatViewerPanel(panel, session, highlightMessage, highlightMessageIndex);
    }

    private async _tryOpenInCopilotChat(): Promise<void> {
        const sessionId = this._currentSession?.id;
        if (!sessionId) {
            vscode.window.showWarningMessage('No session ID available');
            return;
        }

        try {
            // Try to open specific session directly (VS Code 1.90+)
            // The workbench.action.chat.open command accepts sessionId in options
            const sessionOpenCommands = [
                // Primary: workbench.action.chat.open with sessionId option object
                { cmd: 'workbench.action.chat.open', args: [{ sessionId: sessionId }] },
                // Alternative object format
                { cmd: 'workbench.action.chat.open', args: [sessionId] },
                // Named session open
                { cmd: 'workbench.action.chat.openSession', args: [sessionId] },
                { cmd: 'github.copilot.chat.openSession', args: [sessionId] },
            ];
            
            let sessionOpened = false;
            for (const { cmd, args } of sessionOpenCommands) {
                try {
                    await vscode.commands.executeCommand(cmd, ...args);
                    sessionOpened = true;
                    // Small delay to let panel initialize
                    await new Promise(resolve => setTimeout(resolve, 200));
                    break;
                } catch {
                    // Try next
                }
            }

            // If session-specific open failed, try opening chat first then navigating
            if (!sessionOpened) {
                const chatCommands = [
                    'workbench.panel.chat.view.copilot.focus',
                    'github.copilot.openChat',
                    'workbench.action.chat.open',
                    'github.copilot-chat.focus'
                ];
                
                for (const cmd of chatCommands) {
                    try {
                        await vscode.commands.executeCommand(cmd);
                        await new Promise(resolve => setTimeout(resolve, 200));
                        break;
                    } catch {
                        // Try next command
                    }
                }
            }

            // Always try to focus the chat input after opening
            const focusCommands = [
                'workbench.action.chat.focusInput',
                'github.copilot.chat.focus'
            ];
            
            for (const cmd of focusCommands) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    break;
                } catch {
                    // Try next
                }
            }

            // Try to show history panel as additional help
            const historyCommands = [
                'workbench.action.chat.history',
                'github.copilot-chat.history'
            ];
            
            let historyOpened = false;
            for (const cmd of historyCommands) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    historyOpened = true;
                    break;
                } catch {
                    // Try next
                }
            }

            // Show helpful message with session info
            const shortId = sessionId.substring(0, 8);
            const sessionTitle = this._currentSession?.title || 'Unknown';
            
            const selection = await vscode.window.showInformationMessage(
                historyOpened 
                    ? `Chat History opened. Look for "${sessionTitle}" (ID: ${shortId}...)`
                    : `Session ID: ${shortId}... - Use Chat History (Cmd+Shift+H in Chat panel) to find this session.`,
                'Copy Session ID',
                'Copy Title'
            );
            
            if (selection === 'Copy Session ID') {
                await vscode.env.clipboard.writeText(sessionId);
                vscode.window.showInformationMessage('Session ID copied!');
            } else if (selection === 'Copy Title') {
                await vscode.env.clipboard.writeText(sessionTitle);
                vscode.window.showInformationMessage('Title copied!');
            }
        } catch (error) {
            // Final fallback
            await vscode.env.clipboard.writeText(sessionId);
            vscode.window.showInformationMessage(
                'Session ID copied to clipboard. Use Chat History panel to find this session.'
            );
        }
    }

    private _openFile(filePath: string, lineNumber?: number) {
        // Handle workspace-relative paths
        let uri: vscode.Uri;
        if (filePath.startsWith('/')) {
            uri = vscode.Uri.file(filePath);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath);
        } else {
            uri = vscode.Uri.file(filePath);
        }

        vscode.workspace.openTextDocument(uri).then(doc => {
            const options: vscode.TextDocumentShowOptions = {};
            if (lineNumber) {
                const position = new vscode.Position(lineNumber - 1, 0);
                options.selection = new vscode.Range(position, position);
            }
            vscode.window.showTextDocument(doc, options);
        }, err => {
            vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
        });
    }

    private _getHtmlContent(session: ChatSession, highlightMessage?: ChatMessage, highlightMessageIndex?: number): string {
        const messages = session.messages.map((msg, idx) => 
            this._renderMessage(msg, idx, highlightMessage, highlightMessageIndex)
        ).join('');

        const sessionIdDisplay = session.id ? session.id.substring(0, 12) + '...' : 'Unknown';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this._escapeHtml(session.title || 'Chat Session')}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <style>
        :root {
            --vscode-editor-background: #1e1e1e;
            --vscode-editor-foreground: #d4d4d4;
            --input-background: #3c3c3c;
            --user-bubble-bg: #2b5278;
            --assistant-bubble-bg: #2d2d30;
            --highlight-bg: #4a4a00;
            --border-color: #404040;
            --link-color: #4fc1ff;
            --timestamp-color: #808080;
            --code-bg: #1e1e1e;
            --accent-color: #0078d4;
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0;
            line-height: 1.5;
        }
        
        .chat-header {
            position: sticky;
            top: 0;
            background: #252526;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            z-index: 100;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        
        .header-left {
            flex: 1;
        }
        
        .chat-header h1 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 4px;
            color: #fff;
        }
        
        .chat-header .meta {
            font-size: 12px;
            color: var(--timestamp-color);
        }
        
        .session-id {
            font-family: 'Consolas', 'Monaco', monospace;
            background: #333;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
        }
        
        .session-id:hover {
            background: #444;
        }
        
        .header-right {
            display: flex;
            gap: 8px;
            margin-left: 16px;
        }
        
        .header-btn {
            background: var(--accent-color);
            color: #fff;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }
        
        .header-btn:hover {
            background: #106ebe;
        }
        
        .header-btn.secondary {
            background: transparent;
            border: 1px solid var(--border-color);
        }
        
        .header-btn.secondary:hover {
            background: #333;
        }
        
        .chat-container {
            max-width: 900px;
            margin: 0 auto;
            padding: 16px;
        }
        
        .message {
            display: flex;
            margin: 16px 0;
            animation: fadeIn 0.3s ease;
            scroll-margin-top: 80px;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        @keyframes highlight-pulse {
            0%, 100% { box-shadow: 0 0 0 2px #ffd700; }
            50% { box-shadow: 0 0 0 4px #ffd700, 0 0 15px rgba(255, 215, 0, 0.5); }
        }
        
        .message.user {
            flex-direction: row-reverse;
        }
        
        .avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            flex-shrink: 0;
        }
        
        .message.user .avatar {
            background: #0078d4;
            margin-left: 12px;
        }
        
        .message.assistant .avatar {
            background: #6b4fbb;
            margin-right: 12px;
        }
        
        .bubble {
            max-width: 85%;
            padding: 12px 16px;
            border-radius: 12px;
            position: relative;
        }
        
        .message.user .bubble {
            background: var(--user-bubble-bg);
            border-bottom-right-radius: 4px;
        }
        
        .message.assistant .bubble {
            background: var(--assistant-bubble-bg);
            border-bottom-left-radius: 4px;
            border: 1px solid var(--border-color);
        }
        
        .message.highlighted .bubble {
            background: var(--highlight-bg) !important;
            animation: highlight-pulse 2s ease-in-out 3;
        }
        
        .message-index {
            position: absolute;
            top: -8px;
            right: -8px;
            background: #ffd700;
            color: #000;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: bold;
        }
        
        .message-timestamp {
            font-size: 11px;
            color: var(--timestamp-color);
            margin-bottom: 6px;
        }

        .usage-badge {
            display: inline-block;
            margin-left: 8px;
            padding: 1px 8px;
            border-radius: 10px;
            font-size: 10.5px;
            font-weight: 600;
            background: var(--vscode-badge-background, #2d2d30);
            color: var(--vscode-badge-foreground, #cccccc);
            white-space: nowrap;
        }

        .message-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }
        
        .message-actions {
            display: flex;
            gap: 4px;
            opacity: 0;
            transition: opacity 0.2s;
        }
        
        .message:hover .message-actions {
            opacity: 1;
        }
        
        .msg-action-btn {
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 12px;
            opacity: 0.7;
            transition: opacity 0.2s, background 0.2s;
        }
        
        .msg-action-btn:hover {
            opacity: 1;
            background: var(--border-color);
        }
        
        .message-content {
            font-size: 14px;
            line-height: 1.6;
            overflow-wrap: break-word;
        }
        
        .message-content p {
            margin: 8px 0;
        }
        
        .message-content p:first-child {
            margin-top: 0;
        }
        
        .message-content ul, .message-content ol {
            margin: 8px 0;
            padding-left: 24px;
        }
        
        .message-content li {
            margin: 4px 0;
        }
        
        /* Code blocks */
        .code-block-wrapper {
            position: relative;
            margin: 12px 0;
            border-radius: 8px;
            overflow: hidden;
            background: var(--code-bg);
            border: 1px solid var(--border-color);
        }
        
        .code-block-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 12px;
            background: #2d2d30;
            border-bottom: 1px solid var(--border-color);
            font-size: 12px;
            color: var(--timestamp-color);
        }
        
        .copy-btn {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--vscode-editor-foreground);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
        }
        
        .copy-btn:hover {
            background: #3c3c3c;
        }
        
        pre {
            margin: 0;
            padding: 12px;
            overflow-x: auto;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.4;
        }
        
        pre code {
            background: transparent !important;
            padding: 0 !important;
        }
        
        /* Inline code */
        code:not(.hljs) {
            background: #3c3c3c;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
        }
        
        /* File links */
        .file-link {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            color: var(--link-color);
            text-decoration: none;
            background: rgba(79, 193, 255, 0.1);
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
            margin: 2px 0;
        }
        
        .file-link:hover {
            background: rgba(79, 193, 255, 0.2);
            text-decoration: underline;
        }
        
        .file-link::before {
            content: '📄';
            font-size: 12px;
        }
        
        /* Files Referenced section */
        .files-referenced {
            margin-top: 12px;
            padding: 10px;
            background: rgba(79, 193, 255, 0.05);
            border: 1px solid rgba(79, 193, 255, 0.2);
            border-radius: 6px;
        }
        
        .files-header {
            font-size: 12px;
            font-weight: 600;
            color: var(--link-color);
            margin-bottom: 8px;
        }
        
        .files-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        
        .file-link-item {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            color: var(--link-color);
            background: rgba(79, 193, 255, 0.1);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            font-family: 'Consolas', 'Monaco', monospace;
        }
        
        .file-link-item:hover {
            background: rgba(79, 193, 255, 0.25);
        }
        
        .file-link-item.missing {
            color: #f48771;
            background: rgba(244, 135, 113, 0.1);
        }
        
        /* External links */
        .external-link {
            color: var(--link-color);
            text-decoration: none;
            border-bottom: 1px dotted var(--link-color);
            word-break: break-word;
        }
        
        .external-link:hover {
            text-decoration: underline;
            border-bottom-color: transparent;
        }
        
        /* Empty code block */
        .code-block-wrapper.empty-block {
            opacity: 0.6;
        }
        
        .empty-note {
            font-style: italic;
            color: #808080;
        }
        
        /* Files Updated/Created section */
        .files-updated {
            margin-top: 12px;
            padding: 10px;
            background: rgba(80, 200, 120, 0.08);
            border: 1px solid rgba(80, 200, 120, 0.3);
            border-radius: 6px;
        }
        
        .files-updated-header {
            font-size: 12px;
            font-weight: 600;
            color: #50c878;
            margin-bottom: 8px;
        }
        
        .file-update-item {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #50c878;
            background: rgba(80, 200, 120, 0.1);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            font-family: 'Consolas', 'Monaco', monospace;
            margin: 4px 0;
        }
        
        .file-update-item:hover {
            background: rgba(80, 200, 120, 0.25);
        }
        
        .file-update-item .action {
            font-size: 10px;
            text-transform: uppercase;
            opacity: 0.8;
            padding: 1px 4px;
            background: rgba(0,0,0,0.2);
            border-radius: 2px;
        }
        
        /* Mermaid diagrams */
        .mermaid-wrapper {
            margin: 16px 0;
            background: #fff;
            border-radius: 8px;
            padding: 16px;
            overflow-x: auto;
        }
        
        .mermaid {
            display: flex;
            justify-content: center;
        }
        
        /* Links */
        a {
            color: var(--link-color);
        }
        
        /* Tables */
        table {
            border-collapse: collapse;
            margin: 12px 0;
            width: 100%;
        }
        
        th, td {
            border: 1px solid var(--border-color);
            padding: 8px 12px;
            text-align: left;
        }
        
        th {
            background: #2d2d30;
        }
        
        /* Blockquote */
        blockquote {
            border-left: 3px solid #4fc1ff;
            padding-left: 16px;
            margin: 12px 0;
            color: #9cdcfe;
        }
        
        /* Scroll to highlighted */
        .highlight-anchor {
            scroll-margin-top: 100px;
        }
        
        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }
        
        ::-webkit-scrollbar-track {
            background: #1e1e1e;
        }
        
        ::-webkit-scrollbar-thumb {
            background: #424242;
            border-radius: 5px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: #555;
        }
        
        /* Strong and emphasis */
        strong {
            color: #fff;
        }
        
        em {
            color: #dcdcaa;
        }

        /* Headers */
        h1, h2, h3, h4, h5, h6 {
            color: #4fc1ff;
            margin: 16px 0 8px;
        }
        
        h1 { font-size: 1.5em; }
        h2 { font-size: 1.3em; }
        h3 { font-size: 1.1em; }
    </style>
</head>
<body>
    <div class="chat-header">
        <div class="header-left">
            <h1>💬 ${this._escapeHtml(session.title || 'Chat Session')}</h1>
            <div class="meta">
                ${session.messages.length} messages • ${new Date(session.timestamp).toLocaleString()}
                <span class="session-id" onclick="copySessionId()" title="Click to copy full Session ID">${sessionIdDisplay}</span>
            </div>
        </div>
        <div class="header-right">
            <button class="header-btn secondary" onclick="copySessionId()" title="Copy Session ID">📋 Session ID</button>
            <button class="header-btn" onclick="openInCopilot()" title="Open Chat History panel and find this session">↗️ Find in Copilot</button>
        </div>
    </div>
    
    <div class="chat-container">
        ${messages}
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const sessionId = '${session.id || ''}';
        
        // Open in native Copilot Chat
        function openInCopilot() {
            vscode.postMessage({ command: 'openInCopilot' });
        }
        
        // Copy session ID
        function copySessionId() {
            vscode.postMessage({ command: 'copySessionId', sessionId: sessionId });
        }
        
        // Copy single message
        function copyMessage(index) {
            const msgEl = document.getElementById('msg-' + index);
            if (msgEl) {
                const contentEl = msgEl.querySelector('.message-content');
                const rawContent = contentEl?.dataset?.raw || contentEl?.textContent || '';
                // Decode HTML entities
                const txt = document.createElement('textarea');
                txt.innerHTML = rawContent;
                vscode.postMessage({ command: 'copyMessage', content: txt.value, index: index });
            }
        }
        
        // Export single message
        function exportMessage(index) {
            const msgEl = document.getElementById('msg-' + index);
            if (msgEl) {
                const contentEl = msgEl.querySelector('.message-content');
                const rawContent = contentEl?.dataset?.raw || contentEl?.textContent || '';
                const timestampEl = msgEl.querySelector('.message-timestamp');
                const timestamp = timestampEl?.textContent || '';
                const role = msgEl.classList.contains('user') ? 'user' : 'assistant';
                // Decode HTML entities
                const txt = document.createElement('textarea');
                txt.innerHTML = rawContent;
                vscode.postMessage({ command: 'exportMessage', content: txt.value, index: index, role: role, timestamp: timestamp });
            }
        }
        
        // Initialize mermaid
        mermaid.initialize({
            startOnLoad: true,
            theme: 'dark',
            securityLevel: 'loose',
            flowchart: { curve: 'basis' }
        });
        
        // Process markdown content
        document.querySelectorAll('.message-content').forEach(async el => {
            // Already processed during render
        });
        
        // Initialize syntax highlighting
        document.querySelectorAll('pre code').forEach(block => {
            hljs.highlightElement(block);
        });
        
        // Handle copy buttons
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.closest('.code-block-wrapper').querySelector('code').textContent;
                vscode.postMessage({ command: 'copyCode', code: code });
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = 'Copy', 2000);
            });
        });
        
        // Handle file links
        document.querySelectorAll('.file-link').forEach(link => {
            link.addEventListener('click', () => {
                const path = link.dataset.path;
                const line = link.dataset.line ? parseInt(link.dataset.line) : undefined;
                vscode.postMessage({ command: 'openFile', path: path, lineNumber: line });
            });
        });
        
        // Handle file link items in Files Referenced section
        document.querySelectorAll('.file-link-item').forEach(link => {
            link.addEventListener('click', () => {
                const path = link.dataset.path;
                const line = link.dataset.line ? parseInt(link.dataset.line) : undefined;
                vscode.postMessage({ command: 'openFile', path: path, lineNumber: line });
            });
        });
        
        // Scroll to highlighted message
        const highlighted = document.querySelector('.highlight-anchor');
        if (highlighted) {
            setTimeout(() => {
                highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 500);
        }
        
        // Re-render mermaid diagrams
        mermaid.run();
    </script>
</body>
</html>`;
    }

    private _renderMessage(msg: ChatMessage, index: number, highlightMessage?: ChatMessage, highlightMessageIndex?: number): string {
        // Check if this message is highlighted (either by index or by content match)
        const isHighlightedByIndex = highlightMessageIndex !== undefined && index === highlightMessageIndex;
        const isHighlightedByContent = highlightMessage && 
            msg.content === highlightMessage.content && 
            msg.timestamp === highlightMessage.timestamp;
        const isHighlighted = isHighlightedByIndex || isHighlightedByContent;
        
        const highlightClass = isHighlighted ? ' highlighted' : '';
        const anchorClass = isHighlighted ? ' highlight-anchor' : '';
        const roleIcon = msg.role === 'user' ? '👤' : '🤖';
        
        // Show message index badge on highlighted messages
        const indexBadge = isHighlighted ? `<span class="message-index">${index + 1}</span>` : '';
        
        // Process content with markdown-like formatting
        const processedContent = this._processContent(msg.content);
        
        // Build file links section if present
        let fileLinksHtml = '';
        if (msg.fileLinks && msg.fileLinks.length > 0) {
            // Separate files by action type
            const modifiedFiles = msg.fileLinks.filter(l => l.action === 'created' || l.action === 'modified' || l.action === 'deleted');
            const referencedFiles = msg.fileLinks.filter(l => !l.action || l.action === 'referenced');
            
            // Render modified/created/deleted files section
            if (modifiedFiles.length > 0) {
                const modifiedItems = modifiedFiles.map(link => {
                    const displayPath = link.path.split('/').slice(-2).join('/');
                    const lineInfo = link.lineNumber ? `:${link.lineNumber}` : '';
                    const existsClass = link.exists ? '' : ' missing';
                    const actionIcon = link.action === 'created' ? '✨' : link.action === 'deleted' ? '🗑️' : '📝';
                    const actionLabel = link.action || 'modified';
                    return `<div class="file-update-item${existsClass}" data-path="${this._escapeHtml(link.path)}"${link.lineNumber ? ` data-line="${link.lineNumber}"` : ''}>${actionIcon} <span class="action">${actionLabel}</span> ${this._escapeHtml(displayPath)}${lineInfo}</div>`;
                }).join('');
                
                fileLinksHtml += `
                <div class="files-updated">
                    <div class="files-updated-header">🔧 Files Changed (${modifiedFiles.length})</div>
                    <div class="files-list">${modifiedItems}</div>
                </div>`;
            }
            
            // Render referenced files section
            if (referencedFiles.length > 0) {
                const linkItems = referencedFiles.map(link => {
                    const displayPath = link.path.split('/').slice(-2).join('/');
                    const lineInfo = link.lineNumber ? `:${link.lineNumber}` : '';
                    const existsClass = link.exists ? '' : ' missing';
                    const existsIcon = link.exists ? '📄' : '❌';
                    return `<span class="file-link-item${existsClass}" data-path="${this._escapeHtml(link.path)}"${link.lineNumber ? ` data-line="${link.lineNumber}"` : ''}>${existsIcon} ${this._escapeHtml(displayPath)}${lineInfo}</span>`;
                }).join('');
                
                fileLinksHtml += `
                <div class="files-referenced">
                    <div class="files-header">📁 Files Referenced (${referencedFiles.length})</div>
                    <div class="files-list">${linkItems}</div>
                </div>`;
            }
        }
        
        // Escape content for data attribute
        const escapedContent = this._escapeHtml(msg.content).replace(/"/g, '&quot;');
        
        return `
        <div id="msg-${index}" class="message ${msg.role}${highlightClass}${anchorClass}">
            <div class="avatar">${roleIcon}</div>
            <div class="bubble">
                ${indexBadge}
                <div class="message-header">
                    <div class="message-timestamp">
                        ${new Date(msg.timestamp).toLocaleTimeString()} • Message ${index + 1}
                        ${msg.role === 'user' ? usageBadge(msg) : ''}
                    </div>
                    <div class="message-actions">
                        <button class="msg-action-btn copy-btn" onclick="copyMessage(${index})" title="Copy message">📋</button>
                        <button class="msg-action-btn export-btn" onclick="exportMessage(${index})" title="Export message">📤</button>
                    </div>
                </div>
                <div class="message-content" data-raw="${escapedContent}">
                    ${processedContent}
                </div>
                ${fileLinksHtml}
            </div>
        </div>`;
    }

    private _processContent(content: string): string {
        // CRITICAL: Extract code blocks BEFORE HTML escaping
        // Store them with placeholders, restore after processing
        const codeBlocks: Array<{ placeholder: string; html: string }> = [];
        let placeholderIndex = 0;
        
        // Step 1: Extract mermaid diagrams (before any escaping!)
        // Handle both ```mermaid\n and ```mermaid (with optional space/newline)
        let processed = content.replace(/```mermaid[\s\n]+([\s\S]*?)```/g, (match, code) => {
            const placeholder = `__CODEBLOCK_${placeholderIndex++}__`;
            codeBlocks.push({
                placeholder,
                html: `<div class="mermaid-wrapper"><div class="mermaid">${code.trim()}</div></div>`
            });
            return placeholder;
        });
        
        // Step 2: Extract other code blocks (before escaping!)
        // Handle multiple formats: ```lang\n, ```lang , ``` (no lang), and empty content
        processed = processed.replace(/```(\w*)[\s\n]*([\s\S]*?)```/g, (match, lang, code) => {
            const placeholder = `__CODEBLOCK_${placeholderIndex++}__`;
            const trimmedCode = code.trim();
            const language = lang || 'plaintext';
            
            // Handle empty or whitespace-only code blocks
            if (!trimmedCode) {
                codeBlocks.push({
                    placeholder,
                    html: `
                <div class="code-block-wrapper empty-block">
                    <div class="code-block-header">
                        <span>${language}</span>
                        <span class="empty-note">(empty)</span>
                    </div>
                    <pre><code class="language-${language}"></code></pre>
                </div>`
                });
            } else {
                const escapedCode = this._escapeHtml(trimmedCode);
                codeBlocks.push({
                    placeholder,
                    html: `
                <div class="code-block-wrapper">
                    <div class="code-block-header">
                        <span>${language}</span>
                        <button class="copy-btn">Copy</button>
                    </div>
                    <pre><code class="language-${language}">${escapedCode}</code></pre>
                </div>`
                });
            }
            return placeholder;
        });
        
        // Step 3: Extract inline code (before escaping!)
        processed = processed.replace(/`([^`]+)`/g, (match, code) => {
            const placeholder = `__INLINECODE_${placeholderIndex++}__`;
            codeBlocks.push({
                placeholder,
                html: `<code>${this._escapeHtml(code)}</code>`
            });
            return placeholder;
        });
        
        // Step 4: Now escape HTML on the remaining text (safe - no code blocks)
        let html = this._escapeHtml(processed);
        
        // Step 5: Process markdown table syntax BEFORE other processing
        // Handle markdown tables: | col1 | col2 |
        html = this._processTable(html);
        
        // Step 6: Process markdown links [text](path) and [path](path#L10)
        html = html.replace(/\[([^\]]+)\]\(([^)#]+)(?:#L(\d+)(?:-L\d+)?)?\)/g, (match, text, pathOrUrl, line) => {
            // Handle external URLs
            if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
                return `<a href="${pathOrUrl}" class="external-link" target="_blank" rel="noopener">${text} ↗</a>`;
            }
            // Handle file paths
            const lineAttr = line ? ` data-line="${line}"` : '';
            return `<span class="file-link" data-path="${pathOrUrl}"${lineAttr}>${text}</span>`;
        });
        
        // Step 6b: Process standalone URLs (not in markdown format)
        // Match URLs that aren't already in an href or inside tags
        html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<>"')\]]+)/g, (match, url) => {
            // Clean up trailing punctuation
            let cleanUrl = url;
            const trailingPunct = cleanUrl.match(/[.,;:!?)]+$/);
            let suffix = '';
            if (trailingPunct) {
                suffix = trailingPunct[0];
                cleanUrl = cleanUrl.slice(0, -suffix.length);
            }
            // Truncate display for very long URLs
            const displayUrl = cleanUrl.length > 60 ? cleanUrl.substring(0, 57) + '...' : cleanUrl;
            return `<a href="${cleanUrl}" class="external-link" target="_blank" rel="noopener">${displayUrl} ↗</a>${suffix}`;
        });
        
        // Step 7: Process inline file paths like `src/file.ts:10` or bare paths
        // Pattern: path/to/file.ext:lineNum or path/to/file.ext
        // Avoid matching URLs or already-processed links
        html = html.replace(/(?<!href="|data-path="|class="|["\w\/])([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10})(?::(\d+))?(?!["\w])/g, (match, filePath, line) => {
            // Skip if it looks like a URL or domain
            if (filePath.includes('://') || filePath.match(/^www\./i)) {
                return match;
            }
            // Only process if it looks like a real file path
            if (filePath.includes('/') || filePath.match(/\.(ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml|sh|css|html|xml|sql|rb|php|swift|kt|c|cpp|h|hpp)$/i)) {
                const lineAttr = line ? ` data-line="${line}"` : '';
                const lineDisplay = line ? `:${line}` : '';
                return `<span class="file-link" data-path="${filePath}"${lineAttr}>${filePath}${lineDisplay}</span>`;
            }
            return match;
        });
        
        // Step 8: Process bold **text** 
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Step 9: Process italic *text*
        html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
        
        // Step 10: Process headers
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        
        // Step 11: Process blockquotes (> becomes &gt; after escaping)
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        
        // Step 12: Process unordered lists
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        
        // Step 13: Process numbered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        
        // Step 14: Process horizontal rules
        html = html.replace(/^---$/gm, '<hr>');
        
        // Step 15: Convert double newlines to paragraphs
        html = html.replace(/\n\n+/g, '</p><p>');
        html = `<p>${html}</p>`;
        
        // Step 16: Clean up paragraphs around block elements
        html = html.replace(/<p>\s*<\/p>/g, '');
        html = html.replace(/<p>\s*(<div|<ul|<ol|<h[1-6]|<blockquote|<hr|<table)/gi, '$1');
        html = html.replace(/(<\/div>|<\/ul>|<\/ol>|<\/h[1-6]>|<\/blockquote>|<hr>|<\/table>)\s*<\/p>/gi, '$1');
        
        // Step 17: Convert single newlines to <br> in paragraphs
        html = html.replace(/\n/g, '<br>');
        
        // Step 18: FINAL - Restore all code blocks from placeholders
        for (const block of codeBlocks) {
            html = html.replace(block.placeholder, block.html);
        }
        
        return html;
    }
    
    /**
     * Process markdown table syntax into HTML tables
     */
    private _processTable(text: string): string {
        // Match markdown tables: header row, separator row, data rows
        // | col1 | col2 |
        // |------|------|
        // | data | data |
        const tableRegex = /(\|[^\n]+\|\n\|[-:\|\s]+\|\n(?:\|[^\n]+\|\n?)+)/g;
        
        return text.replace(tableRegex, (tableMatch) => {
            const lines = tableMatch.trim().split('\n');
            if (lines.length < 2) return tableMatch;
            
            // Parse header row
            const headerCells = lines[0].split('|').filter(c => c.trim());
            
            // Skip separator row (index 1)
            
            // Parse data rows
            const dataRows = lines.slice(2);
            
            let tableHtml = '<table>\n<thead><tr>';
            for (const cell of headerCells) {
                tableHtml += `<th>${cell.trim()}</th>`;
            }
            tableHtml += '</tr></thead>\n<tbody>';
            
            for (const row of dataRows) {
                if (!row.trim()) continue;
                const cells = row.split('|').filter(c => c.trim() !== '');
                tableHtml += '<tr>';
                for (const cell of cells) {
                    tableHtml += `<td>${cell.trim()}</td>`;
                }
                tableHtml += '</tr>';
            }
            
            tableHtml += '</tbody></table>';
            return tableHtml;
        });
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    public dispose() {
        ChatViewerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
