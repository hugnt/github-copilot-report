import * as vscode from 'vscode';
import { ChatHistoryProvider, ChatSession, ChatMessage } from './chatHistoryProvider';
import { DateRange, isInRange } from './filterState';
import { formatTokens, formatAic, formatUsd, computeUsd, getModelDisplayName } from './modelPricing';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** In-range statistics for a session. */
interface SessionStats {
    promptCount: number;
    inTok: number;
    outTok: number;
    aic: number;
    aicComplete: boolean;
    messages: ChatMessage[];   // only messages inside the range
}

export class ChatTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly session?: ChatSession,
        public readonly message?: ChatMessage
    ) {
        super(label, collapsibleState);
    }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<ChatTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ChatTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private searchResults: ChatMessage[] = [];
    private isShowingSearchResults = false;
    private range: DateRange;

    constructor(
        private chatHistoryProvider: ChatHistoryProvider,
        initialRange: DateRange
    ) {
        this.range = initialRange;
    }

    setRange(range: DateRange): void {
        this.range = range;
        this.isShowingSearchResults = false;
        this.searchResults = [];
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this.isShowingSearchResults = false;
        this.searchResults = [];
        this._onDidChangeTreeData.fire();
    }

    showSearchResults(results: ChatMessage[]): void {
        this.searchResults = results;
        this.isShowingSearchResults = true;
        this._onDidChangeTreeData.fire();
    }

    clearSearch(): void {
        this.isShowingSearchResults = false;
        this.searchResults = [];
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ChatTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ChatTreeItem): Thenable<ChatTreeItem[]> {
        if (this.isShowingSearchResults) {
            return this.getSearchResultsChildren(element);
        }
        return this.getSessionChildren(element);
    }

    // ---- Search results ----
    private async getSearchResultsChildren(element?: ChatTreeItem): Promise<ChatTreeItem[]> {
        if (element) {
            return [];
        }
        const items: ChatTreeItem[] = [];
        const header = new ChatTreeItem(`🔍 Search Results (${this.searchResults.length})`, vscode.TreeItemCollapsibleState.None);
        header.description = 'Click to clear';
        header.command = { command: 'githubCopilotReport.clearSearch', title: 'Clear Search' };
        items.push(header);

        for (const msg of this.searchResults) {
            const preview = msg.content.substring(0, 80) + (msg.content.length > 80 ? '...' : '');
            const item = new ChatTreeItem(preview, vscode.TreeItemCollapsibleState.None, undefined, msg);
            item.description = this.formatTimestamp(msg.timestamp);
            item.tooltip = msg.content;
            item.iconPath = new vscode.ThemeIcon(msg.role === 'user' ? 'account' : 'copilot');
            item.command = { command: 'githubCopilotReport.openChat', title: 'Open', arguments: [msg] };
            items.push(item);
        }
        return items;
    }

    // ---- Filtered session tree ----
    private computeStats(session: ChatSession): SessionStats {
        const stats: SessionStats = { promptCount: 0, inTok: 0, outTok: 0, aic: 0, aicComplete: true, messages: [] };
        for (const msg of session.messages) {
            if (this.range.mode !== 'all' && !isInRange(msg.timestamp, this.range)) {
                continue;
            }
            stats.messages.push(msg);
            if (msg.role === 'user') {
                stats.promptCount++;
                const u = msg.usage;
                if (u) {
                    if (typeof u.inputTokens === 'number') { stats.inTok += u.inputTokens; }
                    if (typeof u.outputTokens === 'number') { stats.outTok += u.outputTokens; }
                    if (typeof u.aic === 'number') { stats.aic += u.aic; } else { stats.aicComplete = false; }
                } else {
                    stats.aicComplete = false;
                }
            }
        }
        return stats;
    }

    private getFilteredSessions(): { session: ChatSession; stats: SessionStats }[] {
        const out: { session: ChatSession; stats: SessionStats }[] = [];
        for (const session of this.chatHistoryProvider.getSessions()) {
            if (session.isDeleted) { continue; }
            const stats = this.computeStats(session);
            if (stats.promptCount === 0) { continue; }
            out.push({ session, stats });
        }
        // Most recent first (by latest in-range message).
        out.sort((a, b) => this.latestTs(b.stats) - this.latestTs(a.stats));
        return out;
    }

    private latestTs(stats: SessionStats): number {
        let t = 0;
        for (const m of stats.messages) { if (m.timestamp > t) { t = m.timestamp; } }
        return t;
    }

    private async getSessionChildren(element?: ChatTreeItem): Promise<ChatTreeItem[]> {
        if (!element) {
            return this.getRootChildren();
        }
        // Date group → sessions
        const grpSessions = (element as any).sessions as { session: ChatSession; stats: SessionStats }[] | undefined;
        if (grpSessions) {
            return grpSessions.map(({ session, stats }) => this.makeSessionItem(session, stats));
        }
        // Session → messages
        if (element.session) {
            const stats = (element as any).stats as SessionStats;
            const msgs = stats ? stats.messages : element.session.messages;
            return msgs.map(msg => this.makeMessageItem(msg));
        }
        return [];
    }

    private getRootChildren(): ChatTreeItem[] {
        const filtered = this.getFilteredSessions();

        // Totals across the filter.
        let totalPrompts = 0, totalIn = 0, totalOut = 0, totalAic = 0;
        let aicComplete = true;
        for (const { stats } of filtered) {
            totalPrompts += stats.promptCount;
            totalIn += stats.inTok;
            totalOut += stats.outTok;
            totalAic += stats.aic;
            if (!stats.aicComplete) { aicComplete = false; }
        }

        const items: ChatTreeItem[] = [];

        // Summary header.
        const summary = new ChatTreeItem(`📊 ${this.range.label}`, vscode.TreeItemCollapsibleState.None);
        summary.description = `${filtered.length} chats · ${totalPrompts} prompts · ${formatAic(totalAic)}${aicComplete ? '' : '+'} AIC · ${formatUsd(computeUsd(totalAic))}`;
        summary.tooltip = new vscode.MarkdownString(
            `**${this.range.label}**\n\n` +
            `- Chats: **${filtered.length}**\n` +
            `- Prompts: **${totalPrompts}**\n` +
            `- Input tokens: **${totalIn.toLocaleString()}**\n` +
            `- Output tokens: **${totalOut.toLocaleString()}**\n` +
            `- Total tokens: **${(totalIn + totalOut).toLocaleString()}**\n` +
            `- AIC: **${formatAic(totalAic)}${aicComplete ? '' : '+'}**\n` +
            `- Est. cost: **${formatUsd(computeUsd(totalAic))}${aicComplete ? '' : '+'}**` +
            (aicComplete ? '' : '\n\n_“+” means some prompts used a model with unknown pricing._')
        );
        summary.iconPath = new vscode.ThemeIcon('graph');
        summary.contextValue = 'summary';
        items.push(summary);

        if (filtered.length === 0) {
            const allTime = this.chatHistoryProvider.getRangeSummary(0, Number.MAX_SAFE_INTEGER);
            const empty = new ChatTreeItem(`No chats in ${this.range.label}`, vscode.TreeItemCollapsibleState.None);
            empty.description = allTime.prompts > 0
                ? `You have ${allTime.prompts} prompts overall — switch the filter above`
                : 'No Copilot chats found yet';
            empty.tooltip = allTime.prompts > 0
                ? `Use the “Time range” dropdown (or the filter button in the title bar) to pick This Week / All time.`
                : undefined;
            empty.iconPath = new vscode.ThemeIcon('info');
            items.push(empty);
            return items;
        }

        // Group by day.
        const groups = this.groupByDay(filtered);
        for (const [label, entries] of groups) {
            const groupItem = new ChatTreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
            let gp = 0, ga = 0; let gComplete = true;
            for (const e of entries) { gp += e.stats.promptCount; ga += e.stats.aic; if (!e.stats.aicComplete) { gComplete = false; } }
            groupItem.description = `${entries.length} chats · ${gp} prompts · ${formatAic(ga)}${gComplete ? '' : '+'} AIC · ${formatUsd(computeUsd(ga))}`;
            groupItem.iconPath = new vscode.ThemeIcon('calendar');
            groupItem.contextValue = 'dateGroup';
            (groupItem as any).sessions = entries;
            items.push(groupItem);
        }
        return items;
    }

    private makeSessionItem(session: ChatSession, stats: SessionStats): ChatTreeItem {
        const item = new ChatTreeItem(session.title, vscode.TreeItemCollapsibleState.Collapsed, session);
        const modelStr = session.models.length ? ' · ' + session.models.map(getModelDisplayName).join(', ') : '';
        item.description = `${stats.promptCount} prompts · ${formatTokens(stats.inTok + stats.outTok)} tok · ${formatAic(stats.aic)}${stats.aicComplete ? '' : '+'} AIC · ${formatUsd(computeUsd(stats.aic))}`;
        item.tooltip = new vscode.MarkdownString(
            `**${session.title}**\n\n` +
            `- ${this.formatTimestamp(this.latestTs(stats))}${session.workspaceLabel ? ` · _${session.workspaceLabel}_` : ''}\n` +
            `- Prompts: **${stats.promptCount}**\n` +
            `- Input: **${stats.inTok.toLocaleString()}** · Output: **${stats.outTok.toLocaleString()}** tokens\n` +
            `- AIC: **${formatAic(stats.aic)}${stats.aicComplete ? '' : '+'}**\n` +
            `- Est. cost: **${formatUsd(computeUsd(stats.aic))}${stats.aicComplete ? '' : '+'}**` +
            (modelStr ? `\n- Models: ${session.models.map(getModelDisplayName).join(', ')}` : '')
        );
        item.iconPath = session.isArchived ? new vscode.ThemeIcon('archive') : new vscode.ThemeIcon('comment-discussion');
        item.contextValue = 'chatSession';
        (item as any).stats = stats;
        item.command = { command: 'githubCopilotReport.openSession', title: 'Open Session', arguments: [session] };
        return item;
    }

    private makeMessageItem(msg: ChatMessage): ChatTreeItem {
        const isUser = msg.role === 'user';
        const previewLen = isUser ? 70 : 60;
        const preview = msg.content.replace(/\s+/g, ' ').substring(0, previewLen) + (msg.content.length > previewLen ? '…' : '');
        const icon = isUser ? '👤' : '🤖';
        const item = new ChatTreeItem(`${icon} ${preview}`, vscode.TreeItemCollapsibleState.None, undefined, msg);
        item.iconPath = new vscode.ThemeIcon(isUser ? 'account' : 'copilot');

        if (isUser && msg.usage) {
            const u = msg.usage;
            const total = (u.inputTokens || 0) + (u.outputTokens || 0);
            // The token / AIC / USD badge shown next to each prompt.
            item.description = `▲${formatTokens(u.inputTokens)} ▼${formatTokens(u.outputTokens)} · ${formatAic(u.aic)} AIC · ${formatUsd(computeUsd(u.aic))}`;
            item.tooltip = new vscode.MarkdownString(
                `**Prompt** · ${this.formatTimestamp(msg.timestamp)}\n\n` +
                `${this.mdEscape(msg.content.substring(0, 400))}\n\n---\n` +
                `- Model: **${getModelDisplayName(u.model)}**\n` +
                `- Input tokens: **${(u.inputTokens ?? 0).toLocaleString()}**\n` +
                `- Output tokens: **${(u.outputTokens ?? 0).toLocaleString()}**\n` +
                (u.cacheTokens ? `- Cached tokens: **${u.cacheTokens.toLocaleString()}**\n` : '') +
                `- Total tokens: **${total.toLocaleString()}**\n` +
                `- AIC: **${formatAic(u.aic)}**${u.nanoAiu !== undefined ? ' _(actual)_' : ' _(est.)_'}\n` +
                `- Est. cost: **${formatUsd(computeUsd(u.aic))}**`
            );
        } else if (isUser) {
            item.description = 'no usage data';
            item.tooltip = msg.content;
        } else {
            item.tooltip = msg.content;
        }
        item.command = { command: 'githubCopilotReport.openChat', title: 'Open', arguments: [msg] };
        return item;
    }

    // ---- Grouping ----
    private groupByDay(entries: { session: ChatSession; stats: SessionStats }[]): Map<string, { session: ChatSession; stats: SessionStats }[]> {
        const groups = new Map<string, { session: ChatSession; stats: SessionStats }[]>();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const yesterday = today - 86400000;

        // Preserve recency order already established in `entries`.
        for (const e of entries) {
            const ts = this.latestTs(e.stats);
            const d = new Date(ts);
            const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
            let label: string;
            if (dayStart >= today) {
                label = '📅 Today';
            } else if (dayStart >= yesterday) {
                label = '📅 Yesterday';
            } else if (this.range.mode === 'all' && (today - dayStart) > 60 * 86400000) {
                label = `📅 ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
            } else {
                label = `📅 ${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()].substring(0, 3)} ${d.getDate()}`;
            }
            if (!groups.has(label)) { groups.set(label, []); }
            groups.get(label)!.push(e);
        }
        return groups;
    }

    private mdEscape(text: string): string {
        return text.replace(/[\\`*_{}\[\]()#+\-!|>]/g, '\\$&');
    }

    private formatTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();
        if (date.toDateString() === now.toDateString()) {
            return 'Today ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
            date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}
