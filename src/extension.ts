import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChatHistoryProvider, ChatMessage, ChatSession } from './chatHistoryProvider';
import { HistoryTreeProvider } from './historyTreeProvider';
import { SearchViewProvider } from './searchViewProvider';
import { ChatViewerPanel } from './chatViewerPanel';
import { FilterState, FilterMode, MONTHS } from './filterState';
import { exportToExcel, buildClipboardTsv, EXPORT_COLUMNS, DEFAULT_EXPORT_COLUMN_IDS, DateSortOrder } from './excelExport';

const CONFIG_NS = 'githubCopilotReport';
// Bumped to .v2 so pre-existing saved selections (from before the column defaults changed) don't
// silently override the new "necessary fields only" default for users who never touched the picker.
const EXPORT_COLS_KEY = 'githubCopilotReport.exportColumns.v2';
const EXPORT_SORT_KEY = 'githubCopilotReport.exportSortOrder';

let extensionContext: vscode.ExtensionContext;
let chatHistoryProvider: ChatHistoryProvider;
let historyTreeProvider: HistoryTreeProvider;
let searchViewProvider: SearchViewProvider;
let filterState: FilterState;
let stateDbWatchers: fs.FSWatcher[] = [];
let refreshDebounceTimer: NodeJS.Timeout | null = null;
let lastRefreshTime = 0;

export function activate(context: vscode.ExtensionContext) {
    console.log('Github Copilot Report is now active');
    extensionContext = context;

    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const defaultFilter = cfg.get<FilterMode>('defaultFilter', 'month');

    chatHistoryProvider = new ChatHistoryProvider();
    filterState = new FilterState(defaultFilter);
    historyTreeProvider = new HistoryTreeProvider(chatHistoryProvider, filterState.range);
    searchViewProvider = new SearchViewProvider(context.extensionUri, chatHistoryProvider, filterState);

    const treeView = vscode.window.createTreeView('githubCopilotReport.historyView', {
        treeDataProvider: historyTreeProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('githubCopilotReport.searchView', searchViewProvider)
    );

    // React to filter changes: re-render tree + webview stats.
    context.subscriptions.push(
        filterState.onDidChange(range => {
            historyTreeProvider.setRange(range);
            searchViewProvider.updateFilterStats();
        })
    );

    registerCommands(context);

    // Initial index.
    vscode.window.withProgress(
        { location: { viewId: 'githubCopilotReport.historyView' }, title: 'Indexing Copilot chats…' },
        async () => {
            await chatHistoryProvider.refresh();
            historyTreeProvider.refresh();
            searchViewProvider.updateFilterStats();
            setupStateDbWatchers();
        }
    );

    context.subscriptions.push(treeView, filterState, {
        dispose: () => cleanupWatchers()
    });
}

function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.refresh', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Refreshing Copilot report…' },
                async () => {
                    await chatHistoryProvider.refresh();
                    historyTreeProvider.refresh();
                    searchViewProvider.updateFilterStats();
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.setFilter', async () => {
            const picked = await vscode.window.showQuickPick(
                [
                    { label: '$(calendar) This Month', mode: 'month' as FilterMode, description: 'Current calendar month' },
                    { label: '$(calendar) This Week', mode: 'week' as FilterMode, description: 'Monday – Sunday of the current week' },
                    { label: '$(calendar) Pick Month…', mode: 'pickedMonth' as FilterMode, description: 'Choose any month & year' },
                    { label: '$(calendar) Custom Range…', mode: 'range' as FilterMode, description: 'Choose a from – to date range' },
                    { label: '$(infinity) All time', mode: 'all' as FilterMode, description: 'Every chat' }
                ],
                { placeHolder: `Current: ${filterState.range.label}` }
            );
            if (!picked) { return; }
            if (picked.mode === 'range') {
                await promptCustomRange();
            } else if (picked.mode === 'pickedMonth') {
                await promptPickMonth();
            } else {
                filterState.setMode(picked.mode);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.exportExcel', () => exportCurrentFilter())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.copyToClipboard', () => copyCurrentFilter())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.search', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search Copilot chat history',
                placeHolder: 'Enter a search term'
            });
            if (!query) { return; }
            const results = chatHistoryProvider.search(query);
            if (results.length === 0) {
                vscode.window.showInformationMessage(`No results found for "${query}"`);
                return;
            }
            historyTreeProvider.showSearchResults(results);
            const items = results.map(r => ({
                label: `$(comment) ${r.preview.substring(0, 80)}`,
                description: new Date(r.timestamp).toLocaleString(),
                detail: `${r.role}${r.usage ? ` · ${r.usage.inputTokens ?? '?'} in / ${r.usage.outputTokens ?? '?'} out` : ''}`,
                message: r
            }));
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `${results.length} results`,
                matchOnDescription: true,
                matchOnDetail: true
            });
            if (selected) {
                vscode.commands.executeCommand('githubCopilotReport.openChat', selected.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.clearSearch', () => {
            historyTreeProvider.clearSearch();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.openChat', async (msg: ChatMessage) => {
            if (!msg) { return; }
            const session = chatHistoryProvider.getSessionByMessage(msg);
            if (session) {
                ChatViewerPanel.show(session, msg);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('githubCopilotReport.openSession', async (session: ChatSession) => {
            if (!session || !session.messages || session.messages.length === 0) {
                vscode.window.showWarningMessage('This chat has no messages to display');
                return;
            }
            ChatViewerPanel.show(session);
        })
    );
}

/** Prompt for a "YYYY-MM-DD" date string; returns undefined if the user cancelled. */
function isValidDateStr(v: string | undefined): boolean {
    return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());
}

/** Ask the user for a from–to date range (both text inputs) and apply it to the filter. */
async function promptCustomRange(): Promise<void> {
    const fromStr = await vscode.window.showInputBox({
        title: 'Custom Range — From date',
        prompt: 'From date (inclusive)',
        placeHolder: 'YYYY-MM-DD',
        validateInput: v => isValidDateStr(v) ? undefined : 'Enter a valid date as YYYY-MM-DD'
    });
    if (!fromStr) { return; }

    const toStr = await vscode.window.showInputBox({
        title: 'Custom Range — To date',
        prompt: 'To date (inclusive)',
        placeHolder: 'YYYY-MM-DD',
        value: fromStr,
        validateInput: v => isValidDateStr(v) ? undefined : 'Enter a valid date as YYYY-MM-DD'
    });
    if (!toStr) { return; }

    const [fy, fm, fd] = fromStr.split('-').map(Number);
    const [ty, tm, td] = toStr.split('-').map(Number);
    const start = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime();
    const end = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime();
    if (end < start) {
        vscode.window.showErrorMessage('The "to" date must be on or after the "from" date.');
        return;
    }
    filterState.setCustomRange(start, end);
}

/** Ask the user to pick any calendar month (not just the current one). */
async function promptPickMonth(): Promise<void> {
    const now = new Date();
    const items = Array.from({ length: 24 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        return { label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, year: d.getFullYear(), month: d.getMonth() };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a month to filter / export' });
    if (picked) {
        filterState.setPickedMonth(picked.year, picked.month);
    }
}

async function exportCurrentFilter(): Promise<void> {
    const range = filterState.range;
    const sessions = chatHistoryProvider.getSessions();
    const summary = chatHistoryProvider.getRangeSummary(range.start, range.end);

    if (summary.prompts === 0) {
        vscode.window.showWarningMessage(`No prompts found for "${range.label}". Nothing to export.`);
        return;
    }

    // Let the user tick which columns to export, plus the date sort order (necessary fields
    // and ascending order pre-selected & remembered).
    const picked = await pickExportColumns();
    if (!picked) {
        return; // cancelled
    }
    const { columnIds, sortOrder } = picked;

    const stamp = new Date().toISOString().slice(0, 10);
    const rangeSlug = range.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const defaultName = `copilot-report-${rangeSlug}-${stamp}.xlsx`;
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName)),
        filters: { 'Excel Workbook': ['xlsx'] },
        saveLabel: 'Export Copilot Report'
    });
    if (!uri) { return; }

    try {
        const count = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Exporting ${summary.prompts} prompts to Excel…` },
            async () => exportToExcel(sessions, range, uri.fsPath, columnIds, sortOrder)
        );
        const choice = await vscode.window.showInformationMessage(
            `Exported ${count} prompts (${range.label}) to Excel.`,
            'Open File', 'Reveal in Folder'
        );
        if (choice === 'Open File') {
            vscode.env.openExternal(uri);
        } else if (choice === 'Reveal in Folder') {
            vscode.commands.executeCommand('revealFileInOS', uri);
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Excel export failed: ${err?.message || err}`);
        console.error('[CopilotReport] Excel export error:', err);
    }
}

/** Copy the current-filter table to the clipboard as TSV (paste straight into Excel/Sheets). */
async function copyCurrentFilter(): Promise<void> {
    const range = filterState.range;
    const summary = chatHistoryProvider.getRangeSummary(range.start, range.end);
    if (summary.prompts === 0) {
        vscode.window.showWarningMessage(`No prompts found for "${range.label}". Nothing to copy.`);
        return;
    }
    const columnIds = getSavedColumns();
    const sortOrder = getSavedSortOrder();
    const { text, rows, columns } = buildClipboardTsv(chatHistoryProvider.getSessions(), range, columnIds, sortOrder);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
        `Copied ${rows} prompts × ${columns} columns (${range.label}) — paste into Excel or Google Sheets.`
    );
}

/** The saved export/copy column selection, falling back to the necessary defaults. */
function getSavedColumns(): string[] {
    const saved = extensionContext.globalState.get<string[]>(EXPORT_COLS_KEY, DEFAULT_EXPORT_COLUMN_IDS);
    return saved && saved.length ? saved : DEFAULT_EXPORT_COLUMN_IDS;
}

/** The saved date sort order for export/copy, defaulting to oldest-first (ascending). */
function getSavedSortOrder(): DateSortOrder {
    return extensionContext.globalState.get<DateSortOrder>(EXPORT_SORT_KEY, 'asc');
}

const SORT_ASC_ITEM_ID = '__sortAsc';

/**
 * Show a multi-select picker of export columns, with a "sort ascending" checkbox tucked in
 * right after Date. The "necessary" columns and ascending order are pre-ticked; the last
 * choice is remembered. Returns the selected column ids (canonical order) plus the chosen
 * sort order, or undefined if the user cancelled.
 */
async function pickExportColumns(): Promise<{ columnIds: string[]; sortOrder: DateSortOrder } | undefined> {
    const savedSet = new Set(getSavedColumns());
    const savedSortOrder = getSavedSortOrder();

    interface ColItem extends vscode.QuickPickItem { id: string; }
    const items: ColItem[] = [];
    for (const c of EXPORT_COLUMNS) {
        items.push({ id: c.id, label: c.header, detail: c.detail, picked: savedSet.has(c.id) });
        if (c.id === 'date') {
            items.push({
                id: SORT_ASC_ITEM_ID,
                label: '　↳ Sort ascending',
                detail: 'Order rows oldest → newest (unchecked = newest first)',
                picked: savedSortOrder === 'asc'
            });
        }
    }

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Export to Excel — choose columns',
        placeHolder: 'Tick the fields to include (Space to toggle, Enter to confirm)'
    }) as ColItem[] | undefined;

    if (!picked) {
        return undefined; // cancelled
    }
    const pickedSet = new Set(picked.map(p => p.id));
    const sortOrder: DateSortOrder = pickedSet.has(SORT_ASC_ITEM_ID) ? 'asc' : 'desc';
    pickedSet.delete(SORT_ASC_ITEM_ID);
    if (pickedSet.size === 0) {
        vscode.window.showWarningMessage('Select at least one column to export.');
        return undefined;
    }

    // Preserve the canonical column order from EXPORT_COLUMNS.
    const ordered = EXPORT_COLUMNS.filter(c => pickedSet.has(c.id)).map(c => c.id);
    await extensionContext.globalState.update(EXPORT_COLS_KEY, ordered);
    await extensionContext.globalState.update(EXPORT_SORT_KEY, sortOrder);
    return { columnIds: ordered, sortOrder };
}

/** Watch state.vscdb files so the report auto-refreshes as you chat. */
function setupStateDbWatchers(): void {
    cleanupWatchers();
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const custom = cfg.get<string>('storagePath', '');
    const base = custom && custom.trim()
        ? (custom.startsWith('~') ? path.join(os.homedir(), custom.slice(1)) : custom)
        : platformDefaultStorage();
    const workspaceStoragePath = path.join(base, 'workspaceStorage');
    if (!fs.existsSync(workspaceStoragePath)) { return; }

    try {
        for (const workspace of fs.readdirSync(workspaceStoragePath)) {
            const stateDbPath = path.join(workspaceStoragePath, workspace, 'state.vscdb');
            if (!fs.existsSync(stateDbPath)) { continue; }
            try {
                const watcher = fs.watch(stateDbPath, () => scheduleRefresh());
                stateDbWatchers.push(watcher);
            } catch { /* ignore unwatchable files */ }
        }
        console.log(`[CopilotReport] Watching ${stateDbWatchers.length} state.vscdb files`);
    } catch (err) {
        console.error('[CopilotReport] Error setting up watchers:', err);
    }
}

function scheduleRefresh(): void {
    const now = Date.now();
    if (now - lastRefreshTime < 500) { return; }
    if (refreshDebounceTimer) { clearTimeout(refreshDebounceTimer); }
    refreshDebounceTimer = setTimeout(async () => {
        lastRefreshTime = Date.now();
        try {
            await chatHistoryProvider.refresh();
            historyTreeProvider.refresh();
            searchViewProvider.updateFilterStats();
        } catch (err) {
            console.error('[CopilotReport] Auto-refresh failed:', err);
        }
    }, 800);
}

function platformDefaultStorage(): string {
    const homeDir = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User');
    } else if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User');
    }
    const desktopPath = path.join(homeDir, '.config', 'Code', 'User');
    const serverPath = path.join(homeDir, '.vscode-server', 'data', 'User');
    return fs.existsSync(desktopPath)
        ? desktopPath
        : (fs.existsSync(serverPath) ? serverPath : desktopPath);
}

function cleanupWatchers(): void {
    for (const w of stateDbWatchers) {
        try { w.close(); } catch { /* ignore */ }
    }
    stateDbWatchers = [];
    if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
        refreshDebounceTimer = null;
    }
}

export function deactivate() {
    cleanupWatchers();
    console.log('Github Copilot Report deactivated');
}
